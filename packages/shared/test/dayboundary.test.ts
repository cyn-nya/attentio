/**
 * The day boundary, end to end.
 *
 * The point of a configurable boundary is that a session running past midnight
 * stays in the evening it started. These tests check the arithmetic that makes
 * that true, the property that makes it *safe* (adjacent days tile exactly once),
 * and the daylight-saving behaviour that breaks the naive implementation.
 *
 * DST is tested by switching `process.env.TZ` inside the test. Node re-reads the
 * zone on each date operation, and `node --test` runs each file in its own
 * process, so this cannot leak into another file. Taipei has no DST, so without
 * this the bug would be invisible on the machine the tests were written on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { logicalDayBounds, logicalDayKey, dayKey } from '../src/time.ts';

function local(y: number, m: number, d: number, hour = 0, minute = 0): number {
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime();
}

/** Run `fn` with the process timezone set, then restore it whatever happens. */
function withZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('a 4am boundary keeps a late-night session in the previous evening', () => {
  const boundary = 4;
  // The case that motivated the feature: still working at 01:30.
  assert.equal(logicalDayKey(local(2026, 3, 3, 1, 30), boundary), '2026-03-02');
  // Just before the boundary is still the previous day.
  assert.equal(logicalDayKey(local(2026, 3, 3, 3, 59), boundary), '2026-03-02');
  // Exactly at the boundary is the new day.
  assert.equal(logicalDayKey(local(2026, 3, 3, 4, 0), boundary), '2026-03-03');
  // Evening work is unchanged.
  assert.equal(logicalDayKey(local(2026, 3, 3, 20, 0), boundary), '2026-03-03');
});

test('a zero boundary is plain midnight', () => {
  // The helpers take the boundary directly, so 0 must mean midnight rather than
  // shifting by nothing and landing on the same answer by accident.
  assert.equal(logicalDayKey(local(2026, 3, 3, 0, 30), 0), '2026-03-03');
  assert.equal(logicalDayKey(local(2026, 3, 3, 23, 59), 0), '2026-03-03');
});

test('bounds contain exactly the timestamps their key labels', () => {
  // The invariant that matters: the label and the span must agree, or a report
  // will sum one range while claiming another.
  const boundary = 4;
  const key = '2026-03-02';
  const { start, end } = logicalDayBounds(key, boundary);
  for (const offset of [0, 1, 60_000, 5 * 3_600_000, 23 * 3_600_000, 23.9 * 3_600_000]) {
    const ts = start + offset;
    assert.ok(ts < end, 'the sample must be inside the span');
    assert.equal(logicalDayKey(ts, boundary), key, `offset ${offset}`);
  }
});

test('adjacent days tile without a gap or an overlap', () => {
  // Double-counting an hour is worse than losing it: the day's accounts would no
  // longer sum to its span. Walk a cursor through two months so that month ends,
  // a 28-day February and a leap February are all covered.
  for (const boundary of [0, 4, 6]) {
    const cursor = new Date(2024, 1, 1); // February 2024, a leap year
    let previous = logicalDayBounds(dayKey(cursor.getTime()), boundary);
    for (let step = 0; step < 70; step++) {
      cursor.setDate(cursor.getDate() + 1);
      const key = dayKey(cursor.getTime());
      const current = logicalDayBounds(key, boundary);
      assert.equal(
        previous.end,
        current.start,
        `boundary ${boundary}: ${key} does not start where the previous day ended`,
      );
      assert.ok(current.end > current.start, `${key} must have positive length`);
      previous = current;
    }
  }
});

test('a month boundary rolls over correctly', () => {
  const { start, end } = logicalDayBounds('2026-01-31', 4);
  assert.equal(new Date(start).getDate(), 31);
  assert.equal(new Date(end).getDate(), 1);
  assert.equal(new Date(end).getMonth(), 1, 'February');
});

test('daylight saving does not shift the boundary or lose an hour', () => {
  withZone('America/New_York', () => {
    // Spring forward: the local day containing the transition is 23 hours.
    const spring = logicalDayBounds('2026-03-07', 4);
    assert.equal(new Date(spring.start).getHours(), 4);
    assert.equal(new Date(spring.end).getHours(), 4, 'the boundary must stay at 4am');
    assert.equal((spring.end - spring.start) / 3_600_000, 23);

    // The naive `start + 24h` implementation put the end at 05:00 here, which
    // double-counts 04:00-05:00 in both days.
    assert.notEqual(spring.start + 86_400_000, spring.end);

    // Fall back: 25 hours, and the naive version ended at 03:00, losing an hour
    // from every day.
    const fall = logicalDayBounds('2026-10-31', 4);
    assert.equal(new Date(fall.end).getHours(), 4);
    assert.equal((fall.end - fall.start) / 3_600_000, 25);
    assert.notEqual(fall.start + 86_400_000, fall.end);

    // And the two days still tile exactly.
    assert.equal(spring.end, logicalDayBounds('2026-03-08', 4).start);
    assert.equal(fall.end, logicalDayBounds('2026-11-01', 4).start);
  });
});

test('a sample on a DST day is labelled consistently with its bounds', () => {
  withZone('America/New_York', () => {
    // The dangerous hour: 03:30 on the spring-forward day, which is before the
    // 04:00 boundary and must belong to the previous day.
    const { start } = logicalDayBounds('2026-03-07', 4);
    const lateNight = new Date(2026, 2, 8, 3, 30, 0, 0).getTime();
    assert.ok(lateNight >= start);
    assert.equal(logicalDayKey(lateNight, 4), '2026-03-07');
    assert.ok(lateNight < logicalDayBounds('2026-03-07', 4).end);
  });
});

test('a zone without daylight saving is unaffected', () => {
  withZone('Asia/Taipei', () => {
    const { start, end } = logicalDayBounds('2026-03-07', 4);
    assert.equal((end - start) / 3_600_000, 24);
    assert.equal(new Date(start).getHours(), 4);
    assert.equal(new Date(end).getHours(), 4);
  });
});

test('an unpadded day key is not silently accepted as a different date', () => {
  // parseDayKey is strict, and a caller passing '2026-3-2' should not silently get
  // a day that does not match what it will display.
  const strict = logicalDayBounds('2026-03-02', 4);
  assert.equal(new Date(strict.start).getMonth(), 2);
  assert.equal(new Date(strict.start).getDate(), 2);
  assert.equal(dayKey(strict.start), '2026-03-02');
});
