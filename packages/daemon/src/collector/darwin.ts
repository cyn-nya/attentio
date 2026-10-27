/**
 * macOS collector.
 *
 * Foreground *application* comes from System Events via `osascript`; the window
 * *title* requires Accessibility permission, so it is treated as optional and
 * the collector reports `degraded` when titles are unavailable rather than
 * pretending the app name is the whole picture.
 *
 * Per-process CPU and memory come from `ps`, which needs no permissions.
 */

import { normalizeWindow } from '@attentio/shared';
import type {
  CollectorStatus,
  Platform,
  ProcessSample,
  SystemSample,
  WindowInventorySample,
  WindowSample,
} from '@attentio/shared';

import { hasCommand, run } from './exec.ts';
import { parseDelimitedList, parseIoregIdleNs, parsePsLine } from './parse.ts';
import { SystemSampler } from './system.ts';
import { capabilities, type Collector } from './types.ts';

export class DarwinCollector implements Collector {
  readonly id = 'darwin';
  readonly platform: Platform = 'darwin';
  readonly recommendedSampleIntervalMs = 2000;

  private readonly systemSampler = new SystemSampler();
  private readonly previousCpu = new Map<string, number>();
  private previousSampleAt = 0;
  private titlesAvailable = true;
  private lastError = '';

  status(): CollectorStatus {
    const detail = this.titlesAvailable
      ? 'Frontmost app and window title via System Events; CPU/memory via ps.'
      : 'Frontmost application is tracked, but window titles need Accessibility permission for your terminal.';
    return {
      id: this.id,
      platform: this.platform,
      health: this.titlesAvailable ? 'ok' : 'degraded',
      detail: this.lastError ? `${detail} Last error: ${this.lastError}` : detail,
      capabilities: capabilities({
        foregroundWindow: true,
        windowTitles: this.titlesAvailable,
        idleTime: true,
        perProcessCpu: true,
        perProcessMemory: true,
        backgroundInventory: true,
        inputActivity: true,
      }),
    };
  }

  dispose(): void {
    this.previousCpu.clear();
  }

  sampleWindow(now: number): WindowSample | null {
    const script = `tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  try
    set winTitle to name of front window of frontApp
  on error
    set winTitle to ""
  end try
  return appName & "\\n" & winTitle
end tell`;
    const result = run('osascript', ['-e', script], 2500);
    if (!result.ok) {
      this.lastError = result.error;
      return null;
    }
    const newline = result.stdout.indexOf('\n');
    const appName = (newline < 0 ? result.stdout : result.stdout.slice(0, newline)).trim();
    // Everything after the first newline is the title: a title can itself contain
    // one, and splitting on every newline would truncate it.
    const windowTitle = newline < 0 ? '' : result.stdout.slice(newline + 1).trimEnd();
    if (!appName) return null;
    if (!windowTitle) this.titlesAvailable = false;

    const pid = this.frontPid(appName);
    const exePath = pid > 0 ? this.exePathOf(pid) : '';
    return {
      ts: now,
      app: normalizeWindow({ exePath, title: windowTitle, appHint: appName }).app,
      exePath,
      pid,
      title: windowTitle,
      idleMs: this.idleMs(),
      elevated: false,
    };
  }

  private frontPid(appName: string): number {
    const result = run('pgrep', ['-x', appName], 1500);
    if (!result.ok) return 0;
    return Number.parseInt(result.stdout.split('\n')[0]?.trim() ?? '0', 10) || 0;
  }

  private idleMs(): number {
    const result = run('ioreg', ['-c', 'IOHIDSystem'], 2000);
    if (!result.ok) return 0;
    // HIDIdleTime is a nanosecond counter.
    return Math.round(parseIoregIdleNs(result.stdout) / 1_000_000);
  }

  sampleProcesses(now: number): ProcessSample[] {
    const result = run('ps', ['-Ao', 'pid=,pcpu=,rss=,comm='], 3000);
    if (!result.ok) return [];

    const samples: ProcessSample[] = [];
    const intervalMs = this.previousSampleAt > 0 ? now - this.previousSampleAt : 0;
    const nextCpu = new Map<string, number>();

    for (const line of result.stdout.split('\n')) {
      const row = parsePsLine(line);
      if (!row) continue;
      const { pid, cpuPct, memBytes, command: exePath } = row;

      // `comm` on macOS is a path where the process has one, but for some system
      // processes it is only a name. Both go through the same stem logic, so the
      // basename fallback below covers the second case.
      const appHint = exePath.includes('/') ? '' : exePath;
      const app = normalizeWindow({ exePath, title: '', appHint }).app;
      if (!app || app === 'Unknown') continue;

      // `ps` gives an instantaneous percentage, not cumulative ticks, so the
      // value passes straight through rather than being differenced.
      nextCpu.set(String(pid), cpuPct);
      samples.push({ ts: now, app, exePath, pid, cpuPct, memBytes });
    }

    this.previousCpu.clear();
    for (const [key, value] of nextCpu) this.previousCpu.set(key, value);
    this.previousSampleAt = now;
    void intervalMs;
    return samples;
  }

  sampleInventory(now: number): WindowInventorySample | null {
    // Delimited with Unit Separator rather than returned as an AppleScript list.
    // "${...}" joins with ", " and application names really do contain commas, so
    // the previous split on ',' fabricated apps out of the halves of real names.
    const script = `set out to ""
tell application "System Events"
  repeat with p in (every application process whose visible is true)
    set out to out & (name of p) & (ASCII character 31)
  end repeat
end tell
return out`;
    const result = run('osascript', ['-e', script], 3000);
    if (!result.ok) return null;
    const names = parseDelimitedList(result.stdout);
    const apps = names
      .map((name) => normalizeWindow({ exePath: '', title: '', appHint: name }).app)
      .filter((app) => app && app !== 'Unknown');
    return { ts: now, apps: [...new Set(apps)], windowCount: names.length };
  }

  sampleSystem(now: number): SystemSample | null {
    try {
      return this.systemSampler.sample(now);
    } catch {
      return null;
    }
  }

  private exePathOf(pid: number): string {
    const result = run('ps', ['-p', String(pid), '-o', 'comm='], 1500);
    return result.ok ? result.stdout.trim() : '';
  }
}

export function hasOsascript(): boolean {
  return hasCommand('osascript');
}
