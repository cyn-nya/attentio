/**
 * The FFI boundary.
 *
 * Attentio talks to Win32 through `koffi`, a prebuilt N-API FFI library. That is
 * a deliberate architectural choice: it means the project needs **no C++
 * compiler, no node-gyp, no MSVC build tools** to observe a Windows machine, so
 * `npm install` works on a clean box. `koffi` is an optional dependency, and
 * this module degrades to `null` when it is missing rather than exploding at
 * import time.
 *
 * The koffi surface is declared as a narrow local interface rather than imported
 * from the package's own types, because koffi is CJS and optional: this keeps
 * the type graph stable whether or not it is installed.
 */

export interface KoffiFunction {
  (...args: unknown[]): unknown;
}

export interface KoffiLibrary {
  func(definition: string): KoffiFunction;
  func(name: string, result: unknown, args: unknown[]): KoffiFunction;
}

export interface KoffiApi {
  load(path: string): KoffiLibrary;
  struct(name: string, definition: Record<string, unknown>): unknown;
  /** Declares a named C prototype, used for Win32 callback signatures. */
  proto?(definition: string): unknown;
  pointer(type: unknown): unknown;
  out(type: unknown): unknown;
  alloc(type: unknown, count: number): unknown;
  sizeof(type: unknown): number;
  decode(pointer: unknown, type: unknown, length?: number): unknown;
  encode(pointer: unknown, type: unknown, value: unknown): void;
  free(pointer: unknown): void;
  register(fn: (...args: unknown[]) => unknown, type: unknown): unknown;
  unregister(fn: unknown): void;
}

let api: KoffiApi | null | undefined;

/** Load koffi once. Returns null when the optional dependency is absent. */
export async function loadKoffi(): Promise<KoffiApi | null> {
  if (api !== undefined) return api;
  try {
    const imported: unknown = await import('koffi');
    const candidate = (imported as { default?: unknown }).default ?? imported;
    api = candidate as KoffiApi;
    if (typeof api.load !== 'function') api = null;
  } catch {
    api = null;
  }
  return api;
}

export function koffiAvailable(): boolean {
  return api !== null && api !== undefined;
}

/** Windows access rights used by the process sampler. */
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
export const PROCESS_VM_READ = 0x0010;
export const PROCESS_QUERY_INFORMATION = 0x0400;
