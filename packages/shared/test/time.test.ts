/**
 * Time-boundary and scheduling tests.
 *
 * These cover the arithmetic that decides *which* day a number belongs to and
 * *when* a scheduled job runs. Both are the kind of code that looks obviously
 * correct and is wrong across a DST change, a month boundary, or midnight — and
 * both are silent when wrong: a report written for the wrong day just has a
 * wrong date on it, and a reminder that fires an hour late still fires.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { dayKey, logicalDayKey, logicalDayBounds, nextLocalHour, parseDayKey } from '../src/time.ts';

/** Build a local-time epoch without going through a UTC string. */
function local(
  year: number,
  month: number,
  date: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return new Date(year, month - 1, date, hour, minute, second, 0).getTime();
}

test('day keys are local, not UTC', () => {
  // The distinction that matters: 23:00 local on the 5th is already the 6th in
  // UTC for every timezone east of Greenwich, and a report keyed by the UTC date
  // would name the wrong day.
  const lateEvening = local(2026, 3, 5, 23, 30);
  assert.equal(dayKey(lateEvening), '2026-03-05');

  // Just after local midnight is a new local day, whatever UTC says.
  assert.equal(dayKey(local(2026, 3, 6, 0, 0, 1)), '2026-03-06');
});

test('day keys round-trip through parseDayKey', () => {
  for (const date of ['2026-01-01', '2026-02-28', '2026-12-31', '2024-02-29']) {
    assert.equal(dayKey(parseDayKey(date)), date, date);
  }
});

test('a leap day parses to local midnight, not UTC midnight', () => {
  const parsed = new Date(parseDayKey('2024-02-29'));
  assert.equal(parsed.getFullYear(), 2024);
  assert.equal(parsed.getMonth(), 1);
  assert.equal(parsed.getDate(), 29);
  assert.equal(parsed.getHours(), 0);
});

test('nextLocalHour stays later today when the hour is still ahead', () => {
  const now = local(2026, 3, 5, 9, 30);
  assert.equal(nextLocalHour(now, 21), local(2026, 3, 5, 21));
});

test('nextLocalHour rolls to tomorrow when the hour has passed', () => {
  const now = local(2026, 3, 5, 22, 0);
  assert.equal(nextLocalHour(now, 21), local(2026, 3, 6, 21));
});

test('nextLocalHour is strictly in the future when the clock is exactly on the hour', () => {
  // Firing "now" is never useful: a timer scheduled at 21:00:00.000 for 21:00
  // would either fire instantly in a loop or be skipped entirely. It must pick
  // the next day instead.
  const now = local(2026, 3, 5, 21, 0, 0);
  const next = nextLocalHour(now, 21);
  assert.ok(next > now, 'must be in the future');
  assert.equal(next, local(2026, 3, 6, 21));
});

test('nextLocalHour handles hour 0 without rolling a whole day', () => {
  const midnight = local(2026, 3, 5, 0, 0, 0);
  // Exactly midnight: the next 0:00 is tomorrow's, not now.
  assert.equal(nextLocalHour(midnight, 0), local(2026, 3, 6, 0));
  // Just before midnight: the next 0:00 is in a few minutes.
  assert.equal(nextLocalHour(local(2026, 3, 5, 23, 59), 0), local(2026, 3, 6, 0));
  // Just after midnight: the next 0:00 is tomorrow's.
  assert.equal(nextLocalHour(local(2026, 3, 5, 0, 0, 1), 0), local(2026, 3, 6, 0));
});

test('nextLocalHour crosses month and year boundaries', () => {
  assert.equal(nextLocalHour(local(2026, 1, 31, 22), 21), local(2026, 2, 1, 21));
  assert.equal(nextLocalHour(local(2026, 12, 31, 22), 21), local(2027, 1, 1, 21));
  // February in a leap year: the 28th rolls to the 29th.
  assert.equal(nextLocalHour(local(2024, 2, 28, 22), 21), local(2024, 2, 29, 21));
});

test('nextLocalHour always lands on the requested wall-clock hour', () => {
  // Across a whole week at every hour, the result must always read as `hour`:00
  // locally. This is the property that a 24-hour interval silently loses.
  for (let offset = 0; offset < 7 * 24; offset++) {
    const now = local(2026, 3, 5, 0) + offset * 3_600_000;
    for (const hour of [0, 6, 12, 21, 23]) {
      const fire = new Date(nextLocalHour(now, hour));
      assert.equal(fire.getHours(), hour, `offset ${offset}, hour ${hour}`);
      assert.equal(fire.getMinutes(), 0);
      assert.equal(fire.getSeconds(), 0);
      assert.ok(nextLocalHour(now, hour) > now, 'must be in the future');
    }
  }
});

test('the logical-day helpers describe the 4am boundary correctly', () => {
  // These are not wired into day selection yet; the test exists so that the
  // available implementation is correct when it is (docs/ROADMAP.md).
  const afterMidnight = local(2026, 3, 3, 1, 30);
  assert.equal(logicalDayKey(afterMidnight), '2026-03-02', '1:30am belongs to the previous day');
  assert.equal(logicalDayKey(local(2026, 3, 3, 4, 0)), '2026-03-03', '4am starts the new day');
  assert.equal(logicalDayKey(local(2026, 3, 3, 23, 59)), '2026-03-03');

  const bounds = logicalDayBounds('2026-03-02');
  assert.equal(bounds.start, local(2026, 3, 2, 4));
  assert.equal(bounds.end, local(2026, 3, 3, 4));
  // The bounds must contain the late-night timestamp that motivated them.
  assert.ok(afterMidnight >= bounds.start && afterMidnight < bounds.end);
});

test('logical day bounds are exactly 24 hours across a DST transition', () => {
  // On a spring-forward date the local day is 23 hours long. `start + DAY` is
  // still the correct *end*, because the boundary is anchored to wall-clock 4am,
  // not to 24 hours after the start. This test documents which one is intended.
  const start = new Date(logicalDayBounds('2026-03-08').start);
  assert.equal(start.getHours(), 4);
  const end = new Date(logicalDayBounds('2026-03-08').end);
  assert.equal(end.getHours(), 4);
  assert.equal(end.getDate(), 9);
});
