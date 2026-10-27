/**
 * Classification, title normalization, focus scoring and day aggregation.
 * These are the surfaces a user will argue with, so they get explicit tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RULES, findDuplicateRuleIds } from '../src/defaultRules.ts';
import { RuleSet } from '../src/rules.ts';
import { extractContext, normalizeWindow } from '../src/titlenorm.ts';
import { scoreFocus, weightPreset } from '../src/focus.ts';
import { aggregateDay, detectFocusBlocks } from '../src/aggregate.ts';
import { dayKey, logicalDayKey, overlapWithDay, parseDayKey, recentDayKeys } from '../src/time.ts';
import { humanBytes, humanDuration } from '../src/format.ts';
import type { ActivitySegment, RollupRow } from '../src/types.ts';

const rules = new RuleSet(DEFAULT_RULES);

/** Classify the way the collector does: normalize first, then match rules. */
const classifyWin = (input: { exePath: string; title: string }) =>
  rules.classify({ ...normalizeWindow(input), ...input });

test('the default ruleset has no duplicate ids', () => {
  assert.deepEqual(findDuplicateRuleIds(DEFAULT_RULES), []);
});

test('every rule id is namespaced so user rules can shadow them predictably', () => {
  for (const rule of DEFAULT_RULES) {
    assert.match(rule.id, /^[a-z]+[a-z0-9-]*\.[a-z0-9.-]+$/, `rule id "${rule.id}" should be namespaced`);
  }
});

test('site rules beat the browser catch-all', () => {
  const yt = classifyWin({ exePath: 'C:/chrome.exe', title: 'Lofi beats - YouTube - Google Chrome' });
  assert.equal(yt.category, 'entertainment');

  const gh = classifyWin({ exePath: 'C:/chrome.exe', title: 'attentio: focus tracker - GitHub' });
  assert.equal(gh.category, 'deep-work');
  assert.equal(gh.ruleId, 'site.code');

  const generic = classifyWin({ exePath: 'C:/chrome.exe', title: 'Some blog post' });
  assert.equal(generic.category, 'reference');
  assert.equal(generic.ruleId, 'browser.generic');
});

test('Chinese desktop software is classified, not left unknown', () => {
  const cases: [string, string][] = [
    ['C:\\Program Files\\Tencent\\WeChat\\WeChat.exe', '微信'],
    ['C:\\Program Files\\DingTalk\\DingTalk.exe', '钉钉'],
    ['C:\\Program Files\\WPS Office\\11.1\\wps.exe', '论文初稿.docx - WPS Writer'],
    ['C:\\Program Files\\Netease\\CloudMusic\\cloudmusic.exe', '网易云音乐'],
  ];
  for (const [exe, title] of cases) {
    const result = classifyWin({ exePath: exe, title });
    assert.notEqual(result.category, 'unknown', `${exe} should be classified`);
  }
});

test('title normalization extracts project, page and document context', () => {
  assert.deepEqual(
    extractContext('code', 'main.ts - attentio - Visual Studio Code', 'VS Code'),
    { context: 'attentio', detail: 'main.ts' },
  );
  assert.equal(extractContext('chrome', 'Pull requests - GitHub - Google Chrome', 'Chrome').context, 'Pull requests - GitHub');
  assert.equal(extractContext('chrome', 'Report and 3 more pages - Personal - Microsoft Edge', 'Microsoft Edge').context, 'Report');
  assert.equal(extractContext('idea64', 'attentio – Engine.kt [~/dev/attentio] – IntelliJ IDEA', 'IntelliJ IDEA').context, 'attentio');
  assert.equal(extractContext('winword', 'Thesis draft.docx - Word', 'Word').context, 'Thesis draft.docx');
  assert.equal(extractContext('windowsterminal', 'user@host: ~/dev/attentio', 'Windows Terminal').context, 'attentio');
  assert.equal(extractContext('chrome', 'New Tab', 'Chrome').context, '');
});

test('title normalization always yields a usable app name', () => {
  for (const exe of ['', 'C:\\weird-path\\unknown-thing.exe', '/usr/bin/foo']) {
    const n = normalizeWindow({ exePath: exe, title: 'x' });
    assert.ok(n.app.length > 0, `app name required for exe="${exe}"`);
  }
});

test('focus score rises with depth and falls with distraction', () => {
  const base = {
    activeMs: 6 * 3_600_000,
    spanMs: 8 * 3_600_000,
    deepMs: 0,
    distractingMs: 0,
    switches: 60,
    longestBlockMin: 60,
    blockCount: 4,
    top3ContextShare: 0.7,
    sampleCoverage: 0.95,
  };
  const good = scoreFocus({ ...base, qualityRatio: 0.85, deepMs: 5 * 3_600_000 });
  const bad = scoreFocus({ ...base, qualityRatio: -0.7, distractingMs: 4 * 3_600_000 });
  assert.ok(good.score > bad.score, `${good.score} should beat ${bad.score}`);
  assert.ok(good.score >= 75, `a deep day should score well, got ${good.score}`);
  assert.ok(bad.score < 45, `a distracted day should score poorly, got ${bad.score}`);
});

test('focus factor contributions sum to the published score', () => {
  const summary = scoreFocus({
    activeMs: 4 * 3_600_000,
    spanMs: 9 * 3_600_000,
    qualityRatio: 0.4,
    deepMs: 2 * 3_600_000,
    distractingMs: 30 * 60_000,
    switches: 120,
    longestBlockMin: 45,
    blockCount: 5,
    top3ContextShare: 0.6,
    sampleCoverage: 0.9,
  });
  const summed = summary.factors.reduce((s, f) => s + f.contribution, 0);
  assert.ok(Math.abs(summed - summary.score) <= 1, `contributions ${summed} vs score ${summary.score}`);
  assert.equal(summary.factors.length, 5);
  for (const f of summary.factors) assert.ok(f.detail.length > 0, `${f.id} needs an explanation`);
});

test('focus confidence reports low data honestly', () => {
  const thin = scoreFocus({
    activeMs: 10 * 60_000,
    spanMs: 8 * 3_600_000,
    qualityRatio: 0.5,
    deepMs: 0,
    distractingMs: 0,
    switches: 2,
    longestBlockMin: 8,
    blockCount: 1,
    top3ContextShare: 0.9,
    sampleCoverage: 0.1,
  });
  assert.ok(thin.confidence < 0.5);
  assert.ok(thin.notes.some((n) => /barely meaningful|not enough data/i.test(n)));
});

test('weight presets change the ranking of a fragmented day', () => {
  const fragmented = {
    activeMs: 6 * 3_600_000,
    spanMs: 9 * 3_600_000,
    qualityRatio: 0.5,
    deepMs: 3 * 3_600_000,
    distractingMs: 20 * 60_000,
    switches: 400,
    longestBlockMin: 12,
    blockCount: 12,
    top3ContextShare: 0.45,
    sampleCoverage: 1,
  };
  const balanced = scoreFocus(fragmented, { weights: weightPreset('balanced') });
  const calm = scoreFocus(fragmented, { weights: weightPreset('calm') });
  assert.notEqual(balanced.score, calm.score, 'presets must actually differ');
});

test('a day aggregates apps, categories, hours and accounts', () => {
  const minute = parseDayKey('2026-03-02') + 9 * 3_600_000;
  const rows: RollupRow[] = [
    row(minute, 'VS Code', 'deep-work', 'attentio', 60_000, 0, 0, 12_000, 1),
    row(minute + 60_000, 'VS Code', 'deep-work', 'attentio', 50_000, 0, 0, 10_000, 1),
    row(minute + 60_000, 'Chrome', 'reference', '', 0, 60_000, 0, 900, 0),
    row(minute + 120_000, '@away', 'idle', '', 0, 0, 60_000, 0, 0),
    row(minute + 180_000, 'Chrome', 'entertainment', 'YouTube', 60_000, 0, 0, 4_000, 1),
  ];
  const stats = aggregateDay({ deviceId: 'd1', day: '2026-03-02', rollups: rows, segments: [] });

  assert.equal(stats.activeMs, 170_000);
  assert.equal(stats.idleMs, 60_000);
  assert.equal(stats.backgroundMs, 60_000);
  assert.equal(stats.cpuMs, 26_900);
  assert.equal(stats.switches, 3);
  assert.equal(stats.apps[0]?.app, 'VS Code');
  const categories = new Map(stats.categories.map((c) => [c.category, c.ms]));
  assert.equal(categories.get('deep-work'), 110_000);
  assert.equal(categories.get('entertainment'), 60_000);
  assert.equal(stats.hours[9]?.activeMs, 170_000);
  assert.equal(stats.hours[9]?.topApp, 'VS Code');
  assert.ok(stats.focus.score > 0 && stats.focus.score <= 100);
  // Away rows must never leak into the app list.
  assert.ok(!stats.apps.some((a) => a.app === '@away'));
});

test('focus blocks merge small gaps but break on distraction', () => {
  const t0 = parseDayKey('2026-03-02') + 10 * 3_600_000;
  const seg = (app: string, category: string, start: number, mins: number): ActivitySegment => ({
    deviceId: 'd1',
    app,
    exePath: '',
    context: 'attentio',
    detail: '',
    title: '',
    category,
    ruleId: 'test',
    start,
    end: start + mins * 60_000,
    idleEnd: false,
  });
  const blocks = detectFocusBlocks(
    [
      seg('Code', 'deep-work', t0, 20),
      seg('Code', 'deep-work', t0 + 21 * 60_000, 20), // 1-minute gap: stays one block
      seg('Chrome', 'entertainment', t0 + 45 * 60_000, 30), // breaks it
      seg('Code', 'deep-work', t0 + 80 * 60_000, 5), // too short to be a block
    ],
    { minBlockMs: 15 * 60_000, blockGapMs: 5 * 60_000, isBlockCategory: (c) => c === 'deep-work' },
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.start, t0);
  assert.equal(blocks[0]?.end, t0 + 41 * 60_000);
  assert.equal(blocks[0]?.contexts[0]?.context, 'attentio');
});

test('day keys and logical days respect local time and the 4am boundary', () => {
  const noon = new Date(2026, 2, 2, 12, 0, 0).getTime();
  assert.equal(dayKey(noon), '2026-03-02');
  assert.equal(parseDayKey('2026-03-02'), new Date(2026, 2, 2).getTime());
  assert.deepEqual(recentDayKeys('2026-03-02', 3), ['2026-02-28', '2026-03-01', '2026-03-02']);

  const lateNight = new Date(2026, 2, 3, 1, 30, 0).getTime();
  assert.equal(dayKey(lateNight), '2026-03-03');
  assert.equal(logicalDayKey(lateNight), '2026-03-02', '1:30am belongs to the previous working day');

  const dayStart = parseDayKey('2026-03-02');
  assert.equal(overlapWithDay(dayStart - 3_600_000, dayStart + 3_600_000, '2026-03-02'), 3_600_000);
});

test('formatters stay readable at boundaries', () => {
  assert.equal(humanDuration(0), '0s');
  assert.equal(humanDuration(59_000), '59s');
  assert.equal(humanDuration(60_000), '1m');
  assert.equal(humanDuration(3_600_000), '1h 00m');
  assert.equal(humanDuration(5_400_000), '1h 30m');
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(1024), '1.0 KB');
  assert.equal(humanBytes(1024 * 1024 * 1024 * 2.5), '2.5 GB');
});

function row(
  minute: number,
  app: string,
  category: string,
  context: string,
  foregroundMs: number,
  backgroundMs: number,
  awayMs: number,
  cpuMs: number,
  switches: number,
): RollupRow {
  return {
    deviceId: 'd1',
    minute,
    app,
    exePath: '',
    category,
    context,
    foregroundMs,
    backgroundMs,
    awayMs,
    cpuMs,
    peakMemBytes: 0,
    switches,
  };
}
