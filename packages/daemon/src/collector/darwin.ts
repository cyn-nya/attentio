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
    const [appName = '', windowTitle = ''] = result.stdout.trimEnd().split('\n');
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
    const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(result.stdout);
    if (!match?.[1]) return 0;
    // HIDIdleTime is in nanoseconds.
    return Math.round(Number(match[1]) / 1_000_000);
  }

  sampleProcesses(now: number): ProcessSample[] {
    const result = run('ps', ['-Ao', 'pid=,pcpu=,rss=,comm='], 3000);
    if (!result.ok) return [];

    const samples: ProcessSample[] = [];
    const intervalMs = this.previousSampleAt > 0 ? now - this.previousSampleAt : 0;
    const nextCpu = new Map<string, number>();

    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const cpuPct = Number(match[2]);
      const memBytes = Number(match[3]) * 1024;
      const exePath = (match[4] ?? '').trim();
      if (!pid || !exePath) continue;

      const app = normalizeWindow({ exePath, title: '' }).app;
      if (!app || app === 'Unknown') continue;

      // `ps` gives an instantaneous percentage, not cumulative ticks; keep the
      // cumulative map for platforms where we can, and pass the value straight
      // through here.
      nextCpu.set(String(pid), cpuPct);
      samples.push({ ts: now, app, exePath, pid, cpuPct: Number.isFinite(cpuPct) ? cpuPct : 0, memBytes });
    }

    this.previousCpu.clear();
    for (const [key, value] of nextCpu) this.previousCpu.set(key, value);
    this.previousSampleAt = now;
    void intervalMs;
    return samples;
  }

  sampleInventory(now: number): WindowInventorySample | null {
    const script = 'tell application "System Events" to get name of every application process whose visible is true';
    const result = run('osascript', ['-e', script], 3000);
    if (!result.ok) return null;
    const apps = result.stdout
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => normalizeWindow({ exePath: '', title: '', appHint: name }).app);
    return { ts: now, apps: [...new Set(apps)], windowCount: apps.length };
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
