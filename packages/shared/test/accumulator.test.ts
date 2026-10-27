/**
 * Accounting tests for the accumulator.
 *
 * These are the tests that matter most: a tracker that double counts, or that
 * invents foreground time while the machine slept, produces numbers that look
 * plausible and are wrong. Every assertion here is about a conservation law.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ActivityAccumulator, AWAY_APP } from '../src/accumulator.ts';
import { DEFAULT_RULES } from '../src/defaultRules.ts';
import { RuleSet } from '../src/rules.ts';
import { normalizeWindow } from '../src/titlenorm.ts';
import type { ProcessSample, RollupRow, WindowSample } from '../src/types.ts';

const MIN = 60_000;
const CODE_EXE = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WORD_EXE = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE';
/** 09:00 local on a fixed date, so minute buckets are deterministic. */
const BASE = new Date(2026, 0, 5, 9, 0, 0, 0).getTime();

const rules = new RuleSet(DEFAULT_RULES);

function makeAccumulator(overrides: Record<string, unknown> = {}): ActivityAccumulator {
  return new ActivityAccumulator({
    deviceId: 'test-device',
    classify: (input) => rules.classify(input),
    idleThresholdMs: 120_000,
    ...overrides,
  });
}

function win(ts: number, exePath: string, title: string, idleMs = 0): WindowSample {
  return {
    ts,
    app: normalizeWindow({ exePath, title }).app,
    exePath,
    pid: 4242,
    title,
    idleMs,
    elevated: false,
  };
}

/** Feed one sample per second from `from` to `to` inclusive. */
function stream(
  acc: ActivityAccumulator,
  from: number,
  to: number,
  exePath: string,
  title: string,
  idleMs = 0,
  stepMs = 1000,
): void {
  for (let t = from; t <= to; t += stepMs) acc.onWindow(win(t, exePath, title, idleMs));
}

function sumForeground(rows: readonly RollupRow[], app?: string): number {
  return rows
    .filter((r) => (app ? r.app === app : r.app !== AWAY_APP))
    .reduce((s, r) => s + r.foregroundMs, 0);
}

function sumAway(rows: readonly RollupRow[]): number {
  return rows.reduce((s, r) => s + r.awayMs, 0);
}

function sumBackground(rows: readonly RollupRow[], app: string): number {
  return rows.filter((r) => r.app === app).reduce((s, r) => s + r.backgroundMs, 0);
}

test('foreground time accrues to the focused app minute by minute', () => {
  const acc = makeAccumulator();
  stream(acc, BASE, BASE + 2 * MIN, CODE_EXE, 'main.ts - attentio - Visual Studio Code');
  const { rollups, segments } = acc.drain(BASE + 2 * MIN, { all: true });

  assert.equal(sumForeground(rollups, 'VS Code'), 2 * MIN);
  assert.equal(sumForeground(rollups), 2 * MIN);
  assert.equal(sumAway(rollups), 0);

  const rows = rollups.filter((r) => r.app === 'VS Code');
  assert.equal(rows.length, 2, 'two minute buckets expected');
  for (const row of rows) assert.equal(row.foregroundMs, MIN);
  for (const row of rows) assert.equal(row.category, 'deep-work');

  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.context, 'attentio');
  assert.equal(segments[0]?.detail, 'main.ts');
});

test('an app with a visible window accrues background time while another is focused', () => {
  const acc = makeAccumulator();
  acc.onInventory({ ts: BASE, apps: ['VS Code', 'Chrome'], windowCount: 2 });
  stream(acc, BASE, BASE + 3 * MIN, CODE_EXE, 'main.ts - attentio - Visual Studio Code');
  const { rollups } = acc.drain(BASE + 3 * MIN, { all: true });

  assert.equal(sumForeground(rollups, 'VS Code'), 3 * MIN);
  assert.equal(sumBackground(rollups, 'Chrome'), 3 * MIN);
  // Chrome never came to the front, so it must have zero engaged time.
  assert.equal(sumForeground(rollups, 'Chrome'), 0);
});

test('away time is detected retroactively and never charged as engagement', () => {
  const acc = makeAccumulator();
  // Two minutes of work, sampled every second.
  stream(acc, BASE, BASE + 2 * MIN, CODE_EXE, 'main.ts - attentio - Visual Studio Code');
  // Then the next sample arrives 2 minutes later with idle already at threshold:
  // the user actually stopped at BASE + 2min.
  acc.onWindow(win(BASE + 4 * MIN, CODE_EXE, 'main.ts - attentio - Visual Studio Code', 2 * MIN));
  const { rollups } = acc.drain(BASE + 4 * MIN, { all: true });

  assert.equal(sumForeground(rollups, 'VS Code'), 2 * MIN, 'exactly the engaged time');
  assert.equal(sumAway(rollups), 2 * MIN, 'the idle stretch lands in the @away account');
  assert.equal(Math.max(...rollups.map((r) => r.foregroundMs)), MIN, 'no minute exceeds 60s of engagement');
});

test('an instant is billed to exactly one account', () => {
  const acc = makeAccumulator();
  acc.onInventory({ ts: BASE, apps: ['VS Code', 'Chrome'], windowCount: 2 });
  stream(acc, BASE, BASE + MIN, CODE_EXE, 'main.ts - attentio - Visual Studio Code');
  stream(acc, BASE + MIN + 1000, BASE + 2 * MIN, CHROME_EXE, 'GitHub - Google Chrome', 0);
  const { rollups } = acc.drain(BASE + 2 * MIN, { all: true });

  const byMinute = new Map<number, number>();
  for (const row of rollups) {
    byMinute.set(row.minute, (byMinute.get(row.minute) ?? 0) + row.foregroundMs + row.awayMs);
  }
  for (const [minute, accounted] of byMinute) {
    assert.equal(accounted, MIN, `minute ${new Date(minute).toISOString()} must account exactly 60s of engaged+away`);
  }
});

test('a gap longer than maxGapMs is discarded rather than invented', () => {
  const acc = makeAccumulator({ maxGapMs: 60_000 });
  stream(acc, BASE, BASE + MIN, CODE_EXE, 'main.ts - attentio - Visual Studio Code');
  // Laptop suspended for an hour, then wakes up.
  const wokeAt = BASE + 60 * MIN;
  acc.onWindow(win(wokeAt, CODE_EXE, 'main.ts - attentio - Visual Studio Code'));
  const { rollups } = acc.drain(BASE + 61 * MIN, { all: true });

  const engaged = sumForeground(rollups, 'VS Code');
  // The minute before the gap and the minute after it. Nothing from the gap
  // itself: we did not observe it, so we must not report it as work.
  assert.equal(engaged, MIN + MIN, 'only the observed minutes are counted');
  assert.equal(
    acc.stats.droppedGapMs,
    60 * MIN - MIN,
    'the entire suspended hour (minus the already-accounted minute) is reported as dropped',
  );
});

test('switching apps counts switches and splits segments', () => {
  const acc = makeAccumulator();
  for (let i = 0; i < 3; i++) {
    stream(acc, BASE + i * 20_000, BASE + i * 20_000 + 9000, CODE_EXE, 'main.ts - attentio - Visual Studio Code');
    stream(acc, BASE + i * 20_000 + 10_000, BASE + i * 20_000 + 19_000, CHROME_EXE, 'Stack Overflow - Google Chrome');
  }
  const { rollups, segments } = acc.drain(BASE + MIN, { all: true });

  const switches = rollups.reduce((s, r) => s + r.switches, 0);
  assert.equal(switches, 6, 'three visits to each of two apps');
  assert.ok(segments.length >= 5, `expected several segments, got ${segments.length}`);
  assert.equal(sumForeground(rollups, 'VS Code'), 30_000);
  assert.equal(sumForeground(rollups, 'Chrome'), 30_000);
});

test('CPU time is distributed across the minutes it was consumed in', () => {
  const acc = makeAccumulator();
  acc.onInventory({ ts: BASE, apps: ['VS Code'], windowCount: 1 });
  stream(acc, BASE, BASE + 3 * MIN, CODE_EXE, 'main.ts - attentio - Visual Studio Code');

  const samples = (ts: number, pct: number): ProcessSample[] => [
    { ts, app: 'VS Code', exePath: CODE_EXE, pid: 12, cpuPct: pct, memBytes: 300 * 1024 * 1024 },
  ];
  // A sample describes CPU at that instant; the value is charged to the
  // interval that *ends* at the next sample. So 50% until 2 minutes = 60s CPU.
  acc.onProcesses(BASE, samples(BASE, 50));
  acc.onProcesses(BASE + 2 * MIN, samples(BASE + 2 * MIN, 0));

  const { rollups } = acc.drain(BASE + 2 * MIN, { all: true });
  const cpu = rollups.filter((r) => r.app === 'VS Code').reduce((s, r) => s + r.cpuMs, 0);
  assert.ok(Math.abs(cpu - 60_000) < 1500, `expected ~60000 cpu-ms, got ${cpu}`);
  const peak = Math.max(...rollups.filter((r) => r.app === 'VS Code').map((r) => r.peakMemBytes));
  assert.equal(peak, 300 * 1024 * 1024);
});

test('a minute is not flushed until the flush grace has passed', () => {
  const acc = makeAccumulator();
  stream(acc, BASE, BASE + 30_000, CODE_EXE, 'main.ts - attentio - Visual Studio Code');
  const early = acc.drain(BASE + 30_000);
  assert.equal(early.rollups.length, 0, 'the incomplete minute stays in memory');

  const late = acc.drain(BASE + 2 * MIN);
  assert.ok(late.rollups.length >= 1, 'the completed minute is flushed');
});

test('classification uses the window title, not just the executable', () => {
  const acc = makeAccumulator();
  stream(acc, BASE, BASE + 30_000, CHROME_EXE, 'Cute cats - YouTube - Google Chrome');
  stream(acc, BASE + 30_000, BASE + MIN, CHROME_EXE, 'attentio: activity tracker - GitHub - Google Chrome');
  const { rollups } = acc.drain(BASE + MIN, { all: true });

  const cats = new Set(rollups.filter((r) => r.app === 'Chrome').map((r) => r.category));
  assert.ok(cats.has('entertainment'), 'YouTube is entertainment');
  assert.ok(cats.has('deep-work'), 'a GitHub repository page is deep work');
});

test('an unknown binary degrades to the unknown category without throwing', () => {
  const acc = makeAccumulator();
  stream(acc, BASE, BASE + 10_000, 'C:\\tools\\mystery-app.exe', 'something');
  const { rollups } = acc.drain(BASE + MIN, { all: true });
  const row = rollups.find((r) => r.foregroundMs > 0 && r.app !== AWAY_APP);
  assert.ok(row, 'a row should exist');
  assert.equal(row?.category, 'unknown');
});
