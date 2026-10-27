/**
 * Local-time helpers.
 *
 * A productivity tool lives and dies on "what does *my* day look like", so
 * every boundary here is computed in the host's local time zone rather than
 * UTC. Timestamps stay epoch milliseconds everywhere; only the bucketing
 * helpers convert to calendar concepts.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Epoch ms floored to the containing minute. */
export function floorToMinute(ts: number): number {
  return Math.floor(ts / MINUTE) * MINUTE;
}

/** Epoch ms floored to the containing hour. */
export function floorToHour(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

/** Local-time `YYYY-MM-DD` key for a timestamp. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a local `YYYY-MM-DD` key into the epoch ms of its local midnight. */
export function parseDayKey(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`invalid day key: ${key}`);
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0).getTime();
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * Start of the local week. `weekStartsOn` uses ISO numbering
 * (1 = Monday, 7 = Sunday) and defaults to Monday.
 */
export function startOfLocalWeek(ts: number, weekStartsOn: 1 | 7 = 1): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const isoDay = d.getDay() === 0 ? 7 : d.getDay();
  const delta = weekStartsOn === 1 ? isoDay - 1 : isoDay % 7;
  d.setDate(d.getDate() - delta);
  return d.getTime();
}

/** Local hour 0..23. */
export function localHour(ts: number): number {
  return new Date(ts).getHours();
}

/**
 * Shift a day key by whole days, staying in local time.
 * Safe across DST because it re-derives midnight from calendar fields.
 */
export function shiftDayKey(key: string, days: number): string {
  const base = new Date(parseDayKey(key));
  base.setDate(base.getDate() + days);
  return dayKey(base.getTime());
}

/** The `count` day keys ending at `key` (inclusive), oldest first. */
export function recentDayKeys(key: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(shiftDayKey(key, -i));
  return out;
}

/**
 * Milliseconds of `[start, end)` that fall inside the local day `key`.
 * Used to attribute a session that straddles midnight to both days.
 */
export function overlapWithDay(start: number, end: number, key: string): number {
  const d0 = parseDayKey(key);
  const d1 = d0 + DAY;
  const lo = Math.max(start, d0);
  const hi = Math.min(end, d1);
  return hi > lo ? hi - lo : 0;
}

/**
 * "Today" for reporting purposes: a day is considered to start at `dayStartHour`
 * so that work done at 01:30 belongs to the previous day's log. Defaults to 4am,
 * which is the convention most sleep-aware trackers converge on.
 *
 * NOT YET USED for day selection. The daemon currently slices days at local
 * midnight (`dayBounds()` in analytics.ts) and the clients follow it, so wiring
 * either of these into a UI on its own would ask for a day the engine never
 * wrote. Implementing the boundary means moving `dayBounds()` and `todayKey()`
 * together and adding `tracking.dayStartHour` to the config; see
 * docs/ROADMAP.md. They are kept, and tested, because this arithmetic is the
 * part that is easy to get wrong.
 */
export function logicalDayKey(ts: number, dayStartHour = 4): string {
  return dayKey(ts - dayStartHour * HOUR);
}

export function logicalDayBounds(key: string, dayStartHour = 4): { start: number; end: number } {
  const start = parseDayKey(key) + dayStartHour * HOUR;
  return { start, end: start + DAY };
}

export function isoWeekKey(ts: number): string {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d.getTime() - week1.getTime()) / DAY - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
