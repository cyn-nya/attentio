/**
 * Small helper for the subprocess-based collectors (Linux, macOS).
 *
 * Those platforms are sampled through system utilities rather than FFI, so the
 * cost profile is completely different from Windows: a 40 ms `xprop` call is
 * fine at 1-2 Hz but not free. Everything here is bounded by a hard timeout so a
 * wedged utility can never stall the sampling loop.
 */

import { execFileSync } from 'node:child_process';

export interface RunResult {
  ok: boolean;
  stdout: string;
  error: string;
}

export function run(command: string, args: readonly string[], timeoutMs = 2000): RunResult {
  try {
    const stdout = execFileSync(command, args as string[], {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, error: '' };
  } catch (error) {
    const err = error as { stdout?: string; message?: string };
    return { ok: false, stdout: typeof err.stdout === 'string' ? err.stdout : '', error: err.message ?? 'failed' };
  }
}

/** True when `command` exists on PATH. Cached by the caller. */
export function hasCommand(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return run(probe, [command], 1500).ok;
}
