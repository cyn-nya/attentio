/**
 * Deterministic engine tests.
 *
 * A scripted collector plus a fake clock means minute accounting is asserted
 * exactly, with no dependence on machine speed, on whether anyone is actually
 * using the computer, or on a real display being present. The live collector
 * tests cover "can we see the machine"; these cover "is the arithmetic right".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeWindow } from '@attentio/shared';
import type {
  CollectorStatus,
  Platform,
  ProcessSample,
  SystemSample,
  WindowInventorySample,
  WindowSample,
} from '@attentio/shared';

import { Db } from '../src/db/index.ts';
import { Engine } from '../src/engine.ts';
import { defaultConfig } from '../src/config.ts';
import type { Collector } from '../src/collector/types.ts';

const CODE = 'C:\\apps\\code.exe';
const STEAM = 'C:\\games\\steam.exe';
const NODE = 'C:\\apps\\node.exe';
const CODE_APP = normalizeWindow({ exePath: CODE, title: '' }).app;
const STEAM_APP = normalizeWindow({ exePath: STEAM, title: '' }).app;

class FakeCollector implements Collector {
  readonly id = 'fake';
  readonly platform: Platform = 'win32';
  window: WindowSample | null = null;
  processes: ProcessSample[] = [];
  inventory: WindowInventorySample = { ts: 0, apps: [], windowCount: 0 };
  system: SystemSample | null = null;

  status(): CollectorStatus {
    return {
      id: this.id,
      platform: this.platform,
      health: 'ok',
      detail: 'scripted collector',
      capabilities: {
        foregroundWindow: true,
        windowTitles: true,
        idleTime: true,
        perProcessCpu: true,
        perProcessMemory: true,
        backgroundInventory: true,
        inputActivity: true,
      },
    };
  }

  dispose(): void {
    /* nothing to release */
  }

  sampleWindow(): WindowSample | null {
    return this.window;
  }

  sampleProcesses(): ProcessSample[] {
    return this.processes;
  }

  sampleInventory(): WindowInventorySample | null {
    return this.inventory;
  }

  sampleSystem(): SystemSample | null {
    return this.system;
  }
}

interface Harness {
  engine: Engine;
  db: Db;
  collector: FakeCollector;
  /** The single clock shared by the engine and the test. */
  clock: { value: number };
  /** Run `steps` sampling cycles, advancing the clock by `stepMs` each time. */
  advance: (steps: number, stepMs?: number) => void;
  cleanup: () => void;
}

/** Wall-clock start aligned to a minute boundary so buckets are easy to reason about. */
function alignedStart(): number {
  return Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'attentio-engine-'));
  const db = new Db(join(dir, 'test.db'));
  const config = defaultConfig();
  config.tracking.captureTitles = true;
  // `excludeApps` and `excludeTitlePatterns` are intentionally left at their
  // shipped defaults so the privacy test verifies the real out-of-the-box
  // protection rather than a test-only configuration.

  const collector = new FakeCollector();
  const clock = { value: alignedStart() };
  const engine = new Engine({ config, db, collector, now: () => clock.value });
  db.upsertDevice({
    id: config.deviceId,
    name: config.deviceName,
    platform: 'win32',
    hostname: 'fake',
    createdAt: clock.value,
    lastSeenAt: clock.value,
    trusted: true,
  });

  return {
    engine,
    db,
    collector,
    clock,
    advance: (steps: number, stepMs = 2000) => {
      for (let i = 0; i < steps; i++) {
        clock.value += stepMs;
        engine.step();
      }
    },
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function windowFor(app: string, exePath: string, pid: number, title = '', idleMs = 0): WindowSample {
  return { ts: 0, app, exePath, pid, title, idleMs, elevated: false };
}

const STEP_MS = 2000;
const PHASE_STEPS = 25; // 50 s

test('foreground, background and away time are accounted separately and never double counted', () => {
  const h = harness();
  try {
    // Phase 1 — deep work in the foreground.
    h.collector.window = windowFor(CODE_APP, CODE, 100, 'a.ts');
    h.collector.processes = [];
    h.advance(PHASE_STEPS, STEP_MS);

    // Phase 2 — entertainment in the foreground.
    h.collector.window = windowFor(STEAM_APP, STEAM, 200, 'Steam');
    h.advance(PHASE_STEPS, STEP_MS);

    // Phase 3 — the editor works in the *background* while something else is in
    // front. This is the case plain time trackers miss entirely.
    h.collector.window = windowFor('Node.js', NODE, 300, 'test runner');
    h.collector.processes = [
      { ts: 0, app: CODE_APP, exePath: CODE, pid: 100, cpuPct: 60, memBytes: 500 * 1024 * 1024 },
      { ts: 0, app: 'Node.js', exePath: NODE, pid: 300, cpuPct: 40, memBytes: 100 * 1024 * 1024 },
    ];
    h.advance(PHASE_STEPS, STEP_MS);

    // Phase 4 — nobody is at the keyboard.
    h.collector.window = windowFor('Node.js', NODE, 300, 'idle', 600_000);
    h.collector.processes = [];
    h.advance(PHASE_STEPS, STEP_MS);

    h.engine.flush({ all: true, now: h.clock.value });

    const rollups = h.db.queryRollups({ from: h.clock.value - 3_600_000, to: h.clock.value + 3_600_000 });
    assert.ok(rollups.length > 0, 'expected rollup rows');

    const sum = (pick: (row: (typeof rollups)[number]) => number) => rollups.reduce((s, r) => s + pick(r), 0);

    // Every millisecond lands in exactly one of engaged / away.
    const accounted = sum((r) => r.foregroundMs) + sum((r) => r.awayMs);
    const expected = PHASE_STEPS * 4 * STEP_MS - STEP_MS;
    assert.ok(Math.abs(accounted - expected) <= STEP_MS * 2, `accounted ${accounted}ms, expected ~${expected}ms`);

    const codeForeground = rollups.filter((r) => r.app === CODE_APP).reduce((s, r) => s + r.foregroundMs, 0);
    const steamForeground = rollups.filter((r) => r.app === STEAM_APP).reduce((s, r) => s + r.foregroundMs, 0);
    assert.ok(Math.abs(codeForeground - 50_000) <= STEP_MS * 2, `code foreground ${codeForeground}`);
    assert.ok(Math.abs(steamForeground - 50_000) <= STEP_MS * 2, `steam foreground ${steamForeground}`);

    // Phase 3 is the point of the whole "background work" feature: the editor
    // was not in front, yet it burned 60% of a core and must still be visible.
    const codeBackground = rollups.filter((r) => r.app === CODE_APP).reduce((s, r) => s + r.backgroundMs, 0);
    assert.ok(codeBackground > 20_000, `expected background time for the editor, got ${codeBackground}`);

    const away = sum((r) => r.awayMs);
    assert.ok(Math.abs(away - 50_000) <= STEP_MS * 2, `away ${away}`);
    assert.ok(
      rollups.filter((r) => r.awayMs > 0).every((r) => r.app === '@away'),
      'away time must belong to the reserved @away bucket',
    );

    const categories = new Set(rollups.map((r) => r.category));
    assert.ok(categories.has('deep-work'), `expected deep-work, saw ${[...categories].join(', ')}`);
    assert.ok(categories.has('entertainment'), 'expected entertainment');
    assert.ok(categories.has('idle'), 'expected idle for away time');

    // The invariant that keeps a day's totals believable.
    const perMinute = new Map<number, number>();
    for (const row of rollups) {
      perMinute.set(row.minute, (perMinute.get(row.minute) ?? 0) + row.foregroundMs + row.awayMs);
    }
    for (const [minute, ms] of perMinute) {
      assert.ok(ms <= 60_000 + 1, `minute ${new Date(minute).toISOString()} over-accounts: ${ms}ms`);
    }
  } finally {
    h.cleanup();
  }
});

test('privacy exclusions keep the time but drop all content', () => {
  const h = harness();
  try {
    h.collector.window = windowFor(
      'Some Secret App',
      'C:\\apps\\1password.exe',
      400,
      'vault: bank account',
    );
    h.collector.processes = [];
    h.advance(PHASE_STEPS, STEP_MS);
    h.engine.flush({ all: true, now: h.clock.value });

    const rollups = h.db.queryRollups({ from: h.clock.value - 3_600_000, to: h.clock.value + 3_600_000 });
    const leaked = rollups.filter((r) => /bank|secret|1password/i.test(`${r.app}${r.context}${r.exePath}`));
    assert.equal(leaked.length, 0, 'excluded windows must not leak app, path or title into the database');
    assert.ok(
      rollups.some((r) => r.app === '@private'),
      'excluded time should still be counted, under the @private bucket',
    );
    assert.ok(
      rollups.filter((r) => r.app === '@private').every((r) => r.context === '' && r.exePath === ''),
      'the @private bucket must carry no content at all',
    );
  } finally {
    h.cleanup();
  }
});

test('a long sleep gap is dropped rather than attributed to whatever was last on screen', () => {
  const h = harness();
  try {
    h.collector.window = windowFor(CODE_APP, CODE, 100);
    h.collector.processes = [];
    h.advance(10, STEP_MS);

    // The machine sleeps for two hours, then wakes on a different app.
    h.clock.value += 2 * 3_600_000;
    h.collector.window = windowFor(STEAM_APP, STEAM, 200);
    h.advance(10, STEP_MS);

    h.engine.flush({ all: true, now: h.clock.value });

    const rollups = h.db.queryRollups({ from: h.clock.value - 4 * 3_600_000, to: h.clock.value + 3_600_000 });
    const totalForeground = rollups.reduce((s, r) => s + r.foregroundMs, 0);
    assert.ok(totalForeground < 120_000, `the sleep gap must not be counted, got ${totalForeground}ms`);
    assert.ok(rollups.some((r) => r.app === CODE_APP), 'work before the gap is kept');
    assert.ok(rollups.some((r) => r.app === STEAM_APP), 'work after the gap is kept');
  } finally {
    h.cleanup();
  }
});

test('a backwards clock re-baselines instead of stalling the timeline', () => {
  const h = harness();
  try {
    h.collector.window = windowFor(CODE_APP, CODE, 100);
    h.collector.processes = [];
    h.advance(10, STEP_MS);

    // An NTP correction drags the clock back five minutes.
    h.clock.value -= 300_000;
    h.advance(10, STEP_MS);
    h.engine.flush({ all: true, now: h.clock.value });

    const stats = h.engine.diagnostics()['accumulator'] as { windowSamples: number; droppedGapMs: number };
    assert.equal(stats.windowSamples, 20, 'no sample may be discarded');
    assert.equal(h.engine.diagnostics()['errors'], 0);

    const rollups = h.db.queryRollups({ from: h.clock.value - 3_600_000, to: h.clock.value + 3_600_000 });
    const totalForeground = rollups.reduce((s, r) => s + r.foregroundMs, 0);
    // Time only ever flows forwards, so the jump back cannot be double counted.
    assert.ok(totalForeground <= 10 * STEP_MS + 1, `expected at most the forward portion, got ${totalForeground}`);
    assert.ok(totalForeground > 0, 'accounting must resume after the clock jump');
  } finally {
    h.cleanup();
  }
});
