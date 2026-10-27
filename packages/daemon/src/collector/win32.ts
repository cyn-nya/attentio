/**
 * Windows collector.
 *
 * Everything here goes through Win32 directly (no WMI, no PowerShell, no
 * polling subprocesses) which is what makes a 1 Hz sample rate affordable:
 * a full foreground read is three cheap syscalls, and the process sweep is
 * ~200 `OpenProcess` + `GetProcessTimes` pairs, measured at well under 50 ms.
 *
 * What it observes, and the API behind each:
 *   foreground window  GetForegroundWindow + GetWindowTextW + GetWindowThreadProcessId
 *   idle time          GetLastInputInfo + GetTickCount64
 *   process CPU        GetProcessTimes (kernel+user deltas over the sample window)
 *   process memory     GetProcessMemoryInfo
 *   executable path    QueryFullProcessImageNameW
 *   background apps    EnumWindows (visible top-level windows)
 *
 * Known blind spot: a foreground window owned by a *higher-integrity* process
 * (an elevated app, or the UAC prompt itself) cannot be opened, so its title and
 * path are unavailable. That is reported honestly via `elevated` rather than
 * silently attributed to something else.
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

import { loadKoffi, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ, type KoffiApi, type KoffiFunction } from './ffi.ts';
import { SystemSampler } from './system.ts';
import { capabilities, type Collector } from './types.ts';

const MAX_WINDOW_TEXT = 1024;
const MAX_PATH_CHARS = 1024;
const MAX_PROCESSES = 4096;
/** Re-resolve an executable path only this often; pids are stable in practice. */
const EXE_CACHE_MS = 60_000;

interface PidInfo {
  key: string;
  exePath: string;
  app: string;
  resolvedAt: number;
}

/**
 * koffi's type registry is **global to the process** and throws when the same
 * struct or prototype name is declared twice. Constructing a second collector
 * therefore used to throw, get swallowed by `create()`, and silently degrade to
 * "no data" — the worst possible failure mode for a tracker. Types and the
 * loaded libraries are consequently memoised here, once per process.
 */
interface Win32Types {
  LASTINPUTINFO: unknown;
  PMC: unknown;
  ENUMPROC: unknown;
  pmcSize: number;
}

interface Win32Libs {
  user32: ReturnType<KoffiApi['load']>;
  kernel32: ReturnType<KoffiApi['load']>;
  psapi: ReturnType<KoffiApi['load']>;
}

let cachedTypes: Win32Types | null = null;
let cachedLibs: Win32Libs | null = null;

function win32Types(koffi: KoffiApi): Win32Types {
  if (cachedTypes) return cachedTypes;
  const LASTINPUTINFO = koffi.struct('AttentioLastInputInfo', { cbSize: 'uint32', dwTime: 'uint32' });
  const PMC = koffi.struct('AttentioProcessMemoryCounters', {
    cb: 'uint32',
    PageFaultCount: 'uint32',
    PeakWorkingSetSize: 'uint64',
    WorkingSetSize: 'uint64',
    QuotaPeakPagedPoolUsage: 'uint64',
    QuotaPagedPoolUsage: 'uint64',
    QuotaPeakNonPagedPoolUsage: 'uint64',
    QuotaNonPagedPoolUsage: 'uint64',
    PagefileUsage: 'uint64',
    PeakPagefileUsage: 'uint64',
  });
  if (!koffi.proto) throw new Error('koffi.proto is unavailable; callback support is required');
  const ENUMPROC = koffi.proto('bool AttentioEnumWindowsProc(void *hwnd, intptr_t lParam)');
  cachedTypes = { LASTINPUTINFO, PMC, ENUMPROC, pmcSize: koffi.sizeof(PMC) };
  return cachedTypes;
}

function win32Libs(koffi: KoffiApi): Win32Libs {
  if (cachedLibs) return cachedLibs;
  cachedLibs = {
    user32: koffi.load('user32.dll'),
    kernel32: koffi.load('kernel32.dll'),
    psapi: koffi.load('psapi.dll'),
  };
  return cachedLibs;
}

export class Win32Collector implements Collector {
  readonly id = 'win32';
  readonly platform: Platform = 'win32';

  private readonly koffi: KoffiApi;
  private readonly user32: ReturnType<KoffiApi['load']>;
  private readonly kernel32: ReturnType<KoffiApi['load']>;
  private readonly psapi: ReturnType<KoffiApi['load']>;

  private readonly GetForegroundWindow: KoffiFunction;
  private readonly GetWindowTextW: KoffiFunction;
  private readonly GetWindowThreadProcessId: KoffiFunction;
  private readonly IsWindowVisible: KoffiFunction;
  private readonly IsIconic: KoffiFunction;
  private readonly EnumWindows: KoffiFunction;
  private readonly GetLastInputInfo: KoffiFunction;

  private readonly OpenProcess: KoffiFunction;
  private readonly CloseHandle: KoffiFunction;
  private readonly GetProcessTimes: KoffiFunction;
  private readonly QueryFullProcessImageNameW: KoffiFunction;
  private readonly GetTickCount64: KoffiFunction;

  private readonly EnumProcesses: KoffiFunction;
  private readonly GetProcessMemoryInfo: KoffiFunction;

  private readonly LASTINPUTINFO: unknown;
  private readonly PMC: unknown;
  private readonly ENUMPROC: unknown;
  private readonly pmcSize: number;

  private readonly systemSampler = new SystemSampler();
  private readonly pidInfo = new Map<number, PidInfo>();
  private previousCpu = new Map<string, number>();
  private previousSampleAt = 0;
  private lastError = '';
  private available = true;

  /** Reused buffers: allocating per sample would churn the GC at 1 Hz. */
  private readonly textBuf = Buffer.alloc(MAX_WINDOW_TEXT * 2);
  private readonly pidBuf = Buffer.alloc(4);
  private readonly pathBuf = Buffer.alloc(MAX_PATH_CHARS * 2);
  private readonly lenBuf = Buffer.alloc(4);
  private readonly pidArray = Buffer.alloc(4 * MAX_PROCESSES);
  private readonly neededBuf = Buffer.alloc(4);
  private readonly createdBuf = Buffer.alloc(8);
  private readonly exitedBuf = Buffer.alloc(8);
  private readonly kernelBuf = Buffer.alloc(8);
  private readonly userBuf = Buffer.alloc(8);

  private constructor(koffi: KoffiApi) {
    this.koffi = koffi;
    const libs = win32Libs(koffi);
    this.user32 = libs.user32;
    this.kernel32 = libs.kernel32;
    this.psapi = libs.psapi;

    // Types first: EnumWindows' signature needs the callback prototype.
    const types = win32Types(koffi);
    this.LASTINPUTINFO = types.LASTINPUTINFO;
    this.PMC = types.PMC;
    this.ENUMPROC = types.ENUMPROC;
    this.pmcSize = types.pmcSize;

    this.GetForegroundWindow = this.user32.func('GetForegroundWindow', 'void *', []);
    this.GetWindowTextW = this.user32.func('GetWindowTextW', 'int', ['void *', 'void *', 'int']);
    this.GetWindowThreadProcessId = this.user32.func('GetWindowThreadProcessId', 'uint32', ['void *', 'void *']);
    this.IsWindowVisible = this.user32.func('IsWindowVisible', 'bool', ['void *']);
    this.IsIconic = this.user32.func('IsIconic', 'bool', ['void *']);
    this.EnumWindows = this.user32.func('EnumWindows', 'bool', [koffi.pointer(this.ENUMPROC), 'intptr_t']);
    this.GetLastInputInfo = this.user32.func('GetLastInputInfo', 'bool', [koffi.pointer(this.LASTINPUTINFO)]);

    this.OpenProcess = this.kernel32.func('OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
    this.CloseHandle = this.kernel32.func('CloseHandle', 'bool', ['void *']);
    this.GetProcessTimes = this.kernel32.func('GetProcessTimes', 'bool', [
      'void *',
      'void *',
      'void *',
      'void *',
      'void *',
    ]);
    this.QueryFullProcessImageNameW = this.kernel32.func('QueryFullProcessImageNameW', 'bool', [
      'void *',
      'uint32',
      'void *',
      'void *',
    ]);
    this.GetTickCount64 = this.kernel32.func('GetTickCount64', 'uint64', []);

    this.EnumProcesses = this.psapi.func('EnumProcesses', 'bool', ['void *', 'uint32', 'void *']);
    this.GetProcessMemoryInfo = this.psapi.func('GetProcessMemoryInfo', 'bool', [
      'void *',
      koffi.out(koffi.pointer(this.PMC)),
      'uint32',
    ]);
  }

  static async create(): Promise<Win32Collector | null> {
    const koffi = await loadKoffi();
    if (!koffi) return null;
    try {
      return new Win32Collector(koffi);
    } catch {
      return null;
    }
  }

  status(): CollectorStatus {
    return {
      id: this.id,
      platform: this.platform,
      health: this.available ? 'ok' : 'degraded',
      detail: this.available
        ? 'Native Win32 sampling: foreground window, idle time, per-process CPU and memory.'
        : `Win32 sampling degraded: ${this.lastError}`,
      capabilities: capabilities({
        foregroundWindow: true,
        windowTitles: true,
        idleTime: true,
        perProcessCpu: true,
        perProcessMemory: true,
        backgroundInventory: true,
        inputActivity: true,
      }),
    };
  }

  dispose(): void {
    this.pidInfo.clear();
    this.previousCpu.clear();
  }

  // ------------------------------------------------------------ foreground
  sampleWindow(now: number): WindowSample | null {
    try {
      const hwnd = this.GetForegroundWindow();
      if (!hwnd) return null;

      const length = Number(this.GetWindowTextW(hwnd, this.textBuf, MAX_WINDOW_TEXT));
      const title = length > 0 ? String(this.koffi.decode(this.textBuf, 'char16_t', length)) : '';

      this.GetWindowThreadProcessId(hwnd, this.pidBuf);
      const pid = this.pidBuf.readUInt32LE(0);

      const info = this.resolvePid(pid, now);
      return {
        ts: now,
        app: info.app,
        exePath: info.exePath,
        pid,
        title,
        idleMs: this.idleMs(),
        elevated: info.exePath === '',
      };
    } catch (error) {
      this.degrade(error);
      return null;
    }
  }

  private idleMs(): number {
    const p = this.koffi.alloc(this.LASTINPUTINFO, 1);
    try {
      this.koffi.encode(p, this.LASTINPUTINFO, { cbSize: this.koffi.sizeof(this.LASTINPUTINFO), dwTime: 0 });
      if (!this.GetLastInputInfo(p)) return 0;
      const value = this.koffi.decode(p, this.LASTINPUTINFO) as { dwTime: number };
      return Math.max(0, Number(this.GetTickCount64()) - Number(value.dwTime));
    } finally {
      this.koffi.free(p);
    }
  }

  // -------------------------------------------------------------- processes
  sampleProcesses(now: number): ProcessSample[] {
    const samples: ProcessSample[] = [];
    try {
      if (!this.EnumProcesses(this.pidArray, this.pidArray.length, this.neededBuf)) return samples;
      const count = this.neededBuf.readUInt32LE(0) / 4;
      const nextCpu = new Map<string, number>();
      const intervalMs = this.previousSampleAt > 0 ? now - this.previousSampleAt : 0;

      for (let i = 0; i < count; i++) {
        const pid = this.pidArray.readUInt32LE(i * 4);
        if (pid === 0 || pid === 4) continue;

        const handle = this.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid);
        if (!handle) continue;

        try {
          if (!this.GetProcessTimes(handle, this.createdBuf, this.exitedBuf, this.kernelBuf, this.userBuf)) {
            continue;
          }

          const cpuMs = filetimeToMs(this.kernelBuf) + filetimeToMs(this.userBuf);
          const key = `${pid}:${this.createdBuf.readBigUInt64LE(0)}`;
          nextCpu.set(key, cpuMs);

          const previous = this.previousCpu.get(key);
          const cpuPct =
            previous !== undefined && intervalMs > 0
              ? Math.max(0, ((cpuMs - previous) / intervalMs) * 100)
              : 0;

          const counters: Record<string, number> = { cb: this.pmcSize };
          let memBytes = 0;
          if (this.GetProcessMemoryInfo(handle, counters, this.pmcSize)) {
            memBytes = Number(counters['WorkingSetSize'] ?? 0);
          }

          const info = this.resolvePid(pid, now, handle);
          if (!info.app) continue;

          samples.push({
            ts: now,
            app: info.app,
            exePath: info.exePath,
            pid,
            cpuPct,
            memBytes,
          });
        } finally {
          this.CloseHandle(handle);
        }
      }

      this.previousCpu = nextCpu;
      this.previousSampleAt = now;
      this.prunePidCache(now);
    } catch (error) {
      this.degrade(error);
    }
    return samples;
  }

  // -------------------------------------------------------------- inventory
  sampleInventory(now: number): WindowInventorySample | null {
    const proto = this.ENUMPROC;
    if (!proto) return null;
    const apps = new Set<string>();
    let windowCount = 0;

    const callback = this.koffi.register((hwnd: unknown) => {
      try {
        if (!this.IsWindowVisible(hwnd)) return true;
        const length = Number(this.GetWindowTextW(hwnd, this.textBuf, MAX_WINDOW_TEXT));
        if (length <= 0) return true;
        windowCount++;
        this.GetWindowThreadProcessId(hwnd, this.pidBuf);
        const pid = this.pidBuf.readUInt32LE(0);
        const info = this.resolvePid(pid, now);
        if (info.app) apps.add(info.app);
      } catch {
        /* a single bad window must not abort the enumeration */
      }
      return true;
    }, this.koffi.pointer(proto));

    try {
      this.EnumWindows(callback, 0);
    } catch (error) {
      this.degrade(error);
    } finally {
      this.koffi.unregister(callback);
    }

    return { ts: now, apps: [...apps], windowCount };
  }

  sampleSystem(now: number): SystemSample | null {
    try {
      return this.systemSampler.sample(now);
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------- helpers
  private resolvePid(pid: number, now: number, existingHandle?: unknown): PidInfo {
    const cached = this.pidInfo.get(pid);
    if (cached && now - cached.resolvedAt < EXE_CACHE_MS) return cached;

    let handle = existingHandle;
    let owned = false;
    if (!handle) {
      handle = this.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      owned = true;
    }

    let exePath = '';
    if (handle) {
      try {
        this.lenBuf.writeUInt32LE(MAX_PATH_CHARS, 0);
        if (this.QueryFullProcessImageNameW(handle, 0, this.pathBuf, this.lenBuf)) {
          const chars = this.lenBuf.readUInt32LE(0);
          exePath = String(this.koffi.decode(this.pathBuf, 'char16_t', chars));
        }
      } catch {
        exePath = '';
      }
    }

    if (owned && handle) this.CloseHandle(handle);

    let app = cached?.app ?? '';
    let key = cached?.key ?? '';
    if (exePath) {
      app = normalizeWindow({ exePath, title: '' }).app;
      key = exePath;
    }
    const info: PidInfo = { key, exePath, app, resolvedAt: now };
    this.pidInfo.set(pid, info);
    return info;
  }

  private prunePidCache(now: number): void {
    if (this.pidInfo.size < 512) return;
    for (const [pid, info] of this.pidInfo) {
      if (now - info.resolvedAt > EXE_CACHE_MS * 5) this.pidInfo.delete(pid);
    }
  }

  private degrade(error: unknown): void {
    this.available = false;
    this.lastError = error instanceof Error ? error.message : String(error);
  }
}

function filetimeToMs(buffer: Buffer): number {
  return Number(buffer.readBigUInt64LE(0)) / 10_000;
}
