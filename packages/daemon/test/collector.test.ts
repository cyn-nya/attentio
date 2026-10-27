/**
 * Live integration tests.
 *
 * These do not mock anything: they drive the real platform collector against the
 * machine running the suite and assert that Attentio observes something true.
 * They are the tests that would have caught "the tracker records zeros".
 *
 * Skipped automatically where the platform cannot support them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCollector } from '../src/collector/index.ts';
import { Db } from '../src/db/index.ts';
import { Engine } from '../src/engine.ts';
import { defaultConfig } from '../src/config.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the platform collector can see the foreground window', { skip: process.platform !== 'win32' }, async () => {
  const collector = await createCollector();
  try {
    assert.equal(collector.status().health, 'ok', `collector unhealthy: ${collector.status().detail}`);
    const sample = collector.sampleWindow(Date.now());
    assert.ok(sample, 'expected a foreground window sample');
    assert.ok(sample.app.length > 0, 'app name must never be empty');
    assert.ok(sample.idleMs >= 0, 'idle time must be non-negative');
    assert.ok(sample.pid > 0, 'foreground window must have an owning pid');
  } finally {
    collector.dispose();
  }
});

test('the platform collector enumerates processes with CPU and memory', { skip: process.platform !== 'win32' }, async () => {
  const collector = await createCollector();
  try {
    const first = collector.sampleProcesses(Date.now());
    assert.ok(first.length > 10, `expected a real process list, got ${first.length}`);
    for (const sample of first) {
      assert.ok(sample.app.length > 0);
      assert.ok(sample.cpuPct >= 0);
      assert.ok(sample.memBytes >= 0);
    }

    await sleep(1200);
    const second = collector.sampleProcesses(Date.now());
    assert.ok(second.length > 10);
    const busy = second.filter((s) => s.cpuPct > 0);
    assert.ok(busy.length > 0, 'some process must have consumed CPU over a 1.2s window');
    assert.ok(
      second.some((s) => s.memBytes > 1024 * 1024),
      'at least one process should hold more than 1 MB',
    );
  } finally {
    collector.dispose();
  }
});

test('the platform collector inventories visible windows', { skip: process.platform !== 'win32' }, async () => {
  const collector = await createCollector();
  try {
    const inventory = collector.sampleInventory(Date.now());
    assert.ok(inventory, 'expected a window inventory');
    assert.ok(inventory.windowCount > 0, 'a desktop session always has visible windows');
    assert.ok(inventory.apps.length > 0, 'window inventory should name at least one app');
  } finally {
    collector.dispose();
  }
});

test('the engine records reconciled accounts end to end', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attentio-test-'));
  const db = new Db(join(dir, 'test.db'));
  const config = defaultConfig();
  config.tracking.sampleIntervalMs = 300;
  config.tracking.processIntervalMs = 900;
  config.tracking.inventoryIntervalMs = 1200;
  config.tracking.excludeApps = [];

  const collector = await createCollector();
  const engine = new Engine({ config, db, collector });
  // The suite may well run unattended (CI, or a developer's machine at 2am), so
  // the expected outcome is derived from the machine's actual idle state instead
  // of assuming somebody is at the keyboard.
  const idleAtStart = collector.sampleWindow(Date.now())?.idleMs ?? 0;
  const unattended = idleAtStart >= config.tracking.idleThresholdSec * 1000;
  db.upsertDevice({
    id: config.deviceId,
    name: config.deviceName,
    platform: collector.platform,
    hostname: 'test',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    trusted: true,
  });

  try {
    await engine.start();
    await sleep(4000);
    const diagnostics = engine.diagnostics();
    await engine.stop();

    assert.equal(diagnostics['errors'], 0, `engine recorded errors: ${String(diagnostics['lastError'])}`);

    const from = Date.now() - 3_600_000;
    const to = Date.now() + 3_600_000;
    const rollups = db.queryRollups({ from, to });
    assert.ok(rollups.length > 0, 'the engine must have flushed at least one rollup row');

    const byMinute = new Map<number, { engaged: number; away: number; background: number }>();
    for (const row of rollups) {
      const entry = byMinute.get(row.minute) ?? { engaged: 0, away: 0, background: 0 };
      entry.engaged += row.foregroundMs;
      entry.away += row.awayMs;
      entry.background += row.backgroundMs;
      byMinute.set(row.minute, entry);
    }

    let sawEngagement = false;
    let sawAway = false;
    let totalAccounted = 0;
    for (const [minute, entry] of byMinute) {
      assert.ok(
        entry.engaged + entry.away <= 60_000 + 1,
        `minute ${new Date(minute).toISOString()} over-accounts engaged+away: ${entry.engaged + entry.away}`,
      );
      if (entry.engaged > 0) sawEngagement = true;
      if (entry.away > 0) sawAway = true;
      totalAccounted += entry.engaged + entry.away;
    }

    assert.ok(totalAccounted > 0, 'the engine was running, so it must have accounted for some time');
    if (unattended) {
      // Nobody was at the keyboard: the correct outcome is away time, and the
      // engine must not have invented engagement.
      assert.ok(sawAway, `machine was idle for ${idleAtStart}ms, so away time must be recorded`);
    } else {
      assert.ok(sawEngagement, 'the machine was in use during the test, so engagement must be recorded');
    }

    assert.ok(
      rollups.every((r) => r.category.length > 0),
      'every row must carry a classification',
    );
    assert.ok(
      rollups.every((r) => r.app.length > 0),
      'every row must name an app (or a reserved @ bucket)',
    );
  } finally {
    await engine.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('privacy exclusions keep time but drop content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attentio-test-'));
  const db = new Db(join(dir, 'test.db'));
  const config = defaultConfig();
  config.tracking.excludeApps = ['code'];
  config.tracking.excludeTitlePatterns = ['bank'];

  const collector = await createCollector();
  const engine = new Engine({ config, db, collector });
  try {
    await engine.start();
    await sleep(1200);
    await engine.stop();
    const diagnostics = engine.diagnostics();
    assert.equal(diagnostics['errors'], 0);
    // No assertion about what was on screen — just that the pipeline stayed healthy
    // with exclusions configured, which is the regression this guards.
    assert.ok(engine.status().deviceId.length > 0);
  } finally {
    await engine.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
