/** Formatting helpers shared by the CLI and the web UI. */

/** `1h 24m`, `12m`, `48s`. Never shows seconds once minutes are involved. */
export function humanDuration(ms: number, opts: { compact?: boolean } = {}): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  if (opts.compact) return `${s}s`;
  return `${s}s`;
}

/** `2.4 GB`, `512 MB`. Binary units, one decimal above 10. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const unit = units[i] ?? 'B';
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${unit}`;
}

/** Clamp helper used across scoring. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear normalization of `v` from `[lo, hi]` into `[0, 1]`. */
export function normalize(v: number, lo: number, hi: number): number {
  if (hi === lo) return 0;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

/**
 * Normalize into `[0, 1]` but treat `mid` as the value that scores 0.5,
 * with a soft falloff. Used for factors where *both* too little and too much
 * are bad (e.g. context switches per hour).
 */
export function bump(v: number, mid: number, width: number): number {
  if (width <= 0) return v === mid ? 1 : 0;
  const d = Math.abs(v - mid) / width;
  return clamp(1 - d * d, 0, 1);
}

export function percent(part: number, whole: number, digits = 0): string {
  if (whole <= 0) return '0%';
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

/** `09:30` in local time. */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Short relative label such as `3m ago`, `2h ago`, `4d ago`. */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return 'in the future';
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Strip a filename to its executable stem, lowercased: `C:\\x\\Code.exe` -> `code`. */
export function exeStem(exePath: string): string {
  if (!exePath) return '';
  const base = exePath.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(exe|app|bin|sh|desktop)$/i, '').toLowerCase();
}

/** Truncate for display without splitting surrogate pairs. */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}
