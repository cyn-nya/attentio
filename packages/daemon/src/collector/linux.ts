/**
 * Linux collector.
 *
 * Process accounting is done natively by reading `/proc` — no dependency, no
 * subprocess, and it works headless. The *foreground window* is the hard part:
 * on X11 it needs Xlib or a helper utility, and under Wayland there is no
 * portable way at all without compositor-specific protocols.
 *
 * v0.1 therefore uses the standard X11 utilities (`xprop`/`xdotool`) when
 * present and reports `degraded` with an explicit reason when it cannot see the
 * foreground window, rather than silently recording nothing. A native Xlib
 * binding through koffi is the planned replacement (see ROADMAP.md).
 */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

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
import {
  parseHexIds,
  parseProcStat,
  parseProcStatm,
  parseXdotoolIds,
  parseXpropActiveWindow,
  parseXpropWindowProps,
  ticksToMs,
} from './parse.ts';
import { SystemSampler } from './system.ts';
import { capabilities, type Collector } from './types.ts';

interface ProcTimes {
  cpuMs: number;
  memBytes: number;
  exePath: string;
  /** The kernel's name for the process; available when `exePath` is not. */
  comm: string;
}

export class LinuxCollector implements Collector {
  readonly id = 'linux';
  readonly platform: Platform = 'linux';
  /** Subprocess-based sampling is more expensive than Windows FFI. */
  readonly recommendedSampleIntervalMs = 2000;

  private readonly systemSampler = new SystemSampler();
  private readonly previousCpu = new Map<string, number>();
  private previousSampleAt = 0;
  private readonly hasXprop: boolean;
  private readonly hasXdotool: boolean;
  private readonly hasXprintidle: boolean;
  private readonly isWayland: boolean;
  private lastError = '';

  constructor() {
    this.hasXprop = hasCommand('xprop');
    this.hasXdotool = hasCommand('xdotool');
    this.hasXprintidle = hasCommand('xprintidle');
    this.isWayland = Boolean(process.env['WAYLAND_DISPLAY']) && !process.env['DISPLAY'];
  }

  status(): CollectorStatus {
    const canSeeWindows = !this.isWayland && (this.hasXprop || this.hasXdotool);
    const detail = canSeeWindows
      ? `X11 window tracking via ${this.hasXdotool ? 'xdotool' : 'xprop'}; per-process CPU from /proc.`
      : this.isWayland
        ? 'Wayland session detected: foreground window tracking is not available yet (per-process CPU still works).'
        : 'Neither xdotool nor xprop is installed, so the foreground window cannot be read (per-process CPU still works).';
    return {
      id: this.id,
      platform: this.platform,
      health: canSeeWindows ? 'ok' : 'degraded',
      detail: this.lastError ? `${detail} Last error: ${this.lastError}` : detail,
      capabilities: capabilities({
        foregroundWindow: canSeeWindows,
        windowTitles: canSeeWindows,
        idleTime: this.hasXprintidle,
        perProcessCpu: true,
        perProcessMemory: true,
        backgroundInventory: canSeeWindows,
        inputActivity: this.hasXprintidle,
      }),
    };
  }

  dispose(): void {
    this.previousCpu.clear();
  }

  sampleWindow(now: number): WindowSample | null {
    if (this.isWayland) return null;
    try {
      let windowId = '';
      let title = '';
      let pid = 0;

      if (this.hasXdotool) {
        const active = run('xdotool', ['getactivewindow']);
        windowId = active.stdout.trim();
        if (windowId) {
          title = run('xdotool', ['getwindowname', windowId]).stdout.trim();
          const pidOut = run('xdotool', ['getwindowpid', windowId]).stdout.trim();
          pid = Number.parseInt(pidOut, 10) || 0;
        }
      } else if (this.hasXprop) {
        const root = run('xprop', ['-root', '-notype', '_NET_ACTIVE_WINDOW']).stdout;
        windowId = parseXpropActiveWindow(root);
        if (windowId) {
          const props = run('xprop', ['-id', windowId, '_NET_WM_NAME', '_NET_WM_PID']).stdout;
          const parsed = parseXpropWindowProps(props);
          title = parsed.title;
          pid = parsed.pid;
        }
      }

      if (!title && !pid) return null;
      const exePath = pid > 0 ? this.exePathOf(pid) : '';
      // Title as an app name would file a page under "GitHub - Chrome". The
      // process name is what the app actually is; the title stays the title.
      const appHint = exePath ? '' : pid > 0 ? this.commOf(pid) : title || 'unknown';
      return {
        ts: now,
        app: normalizeWindow({ exePath, title, appHint }).app,
        exePath,
        pid,
        title,
        idleMs: this.idleMs(),
        elevated: pid > 0 && exePath === '',
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  private idleMs(): number {
    if (!this.hasXprintidle) return 0;
    const result = run('xprintidle', []);
    return result.ok ? Number.parseInt(result.stdout.trim(), 10) || 0 : 0;
  }

  sampleProcesses(now: number): ProcessSample[] {
    const samples: ProcessSample[] = [];
    const nextCpu = new Map<string, number>();
    const intervalMs = this.previousSampleAt > 0 ? now - this.previousSampleAt : 0;

    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      return samples;
    }

    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const times = readProc(pid);
      if (!times) continue;
      if (!times.exePath && times.cpuMs === 0) continue;

      const key = String(pid);
      nextCpu.set(key, times.cpuMs);
      const previous = this.previousCpu.get(key);
      const cpuPct =
        previous !== undefined && intervalMs > 0 ? Math.max(0, ((times.cpuMs - previous) / intervalMs) * 100) : 0;

      // `/proc/<pid>/exe` is a symlink and is *not* readable for processes owned
      // by other users, which on a normal desktop is most of them. Without the
      // comm fallback every such process was named "Pid1234", so the app list
      // filled with anonymous rows and no rule could ever match one.
      const appHint = times.exePath ? '' : times.comm || `pid${pid}`;
      const app = normalizeWindow({ exePath: times.exePath, title: '', appHint }).app;
      if (!app || app === 'Unknown') continue;

      samples.push({ ts: now, app, exePath: times.exePath, pid, cpuPct, memBytes: times.memBytes });
    }

    this.previousCpu.clear();
    for (const [key, value] of nextCpu) this.previousCpu.set(key, value);
    this.previousSampleAt = now;
    return samples;
  }

  sampleInventory(now: number): WindowInventorySample | null {
    if (this.isWayland) return null;
    try {
      const apps = new Set<string>();
      let windowCount = 0;
      if (this.hasXdotool) {
        const list = run('xdotool', ['search', '--onlyvisible', '--name', '.']);
        for (const id of parseXdotoolIds(list.stdout)) {
          windowCount++;
          const pidOut = run('xdotool', ['getwindowpid', id]).stdout.trim();
          const pid = Number.parseInt(pidOut, 10);
          if (!pid) continue;
          apps.add(this.appOf(pid));
        }
      } else if (this.hasXprop) {
        const root = run('xprop', ['-root', '-notype', '_NET_CLIENT_LIST']).stdout;
        const ids = parseHexIds(root);
        windowCount = ids.length;
        for (const id of ids) {
          const props = run('xprop', ['-id', id, '_NET_WM_PID']).stdout;
          const parsed = parseXpropWindowProps(props);
          if (!parsed.pid) continue;
          apps.add(this.appOf(parsed.pid));
        }
      }
      return { ts: now, apps: [...apps], windowCount };
    } catch {
      return null;
    }
  }

  sampleSystem(now: number): SystemSample | null {
    try {
      return this.systemSampler.sample(now);
    } catch {
      return null;
    }
  }

  private exePathOf(pid: number): string {
    try {
      return readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return '';
    }
  }

  /**
   * The process name, which — unlike the `exe` symlink — is readable for every
   * process regardless of which user owns it. Truncated to 15 characters by the
   * kernel, which is a limitation of the source rather than of this code.
   */
  private commOf(pid: number): string {
    try {
      return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch {
      return '';
    }
  }

  /** The resolved app name for a pid, with the comm fallback applied. */
  private appOf(pid: number): string {
    const exePath = this.exePathOf(pid);
    const appHint = exePath ? '' : this.commOf(pid) || `pid${pid}`;
    return normalizeWindow({ exePath, title: '', appHint }).app;
  }
}

function readProc(pid: number): ProcTimes | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseProcStat(stat);
  if (!parsed) return null;
  const cpuMs = ticksToMs(parsed.cpuTicks);

  let memBytes = 0;
  try {
    memBytes = parseProcStatm(readFileSync(`/proc/${pid}/statm`, 'utf8'));
  } catch {
    memBytes = 0;
  }

  let exePath = '';
  try {
    exePath = readlinkSync(`/proc/${pid}/exe`);
  } catch {
    exePath = '';
  }

  return { cpuMs, memBytes, exePath, comm: parsed.comm };
}
