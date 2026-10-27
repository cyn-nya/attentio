/**
 * Day aggregation: rollups + segments -> DayStats.
 *
 * Pure and synchronous, so it can be unit-tested against hand-built rows and
 * reused by the daemon, the CLI and (identically) by the web client for
 * optimistic local recomputation.
 *
 * Definitions worth being precise about, because the UI quotes them:
 *   - `activeMs`  sums *engaged* foreground time (idle removed, one app at a time);
 *   - `backgroundMs` sums app-running time across apps, so it deliberately can
 *     exceed wall-clock: "VS Code was open for 6h, foreground for 2h";
 *   - `idleMs` is the single `@away` account.
 */

import { categoryMeta, categoryProductivity } from './categories.ts';
import { scoreFocus, type FocusWeights } from './focus.ts';
import { localHour } from './time.ts';
import { AWAY_APP } from './accumulator.ts';
import type {
  ActivitySegment,
  AppUsage,
  CategoryUsage,
  DayStats,
  FocusBlock,
  HourBucket,
  RollupRow,
} from './types.ts';

export interface AggregateOptions {
  deviceId: string;
  day: string;
  rollups: readonly RollupRow[];
  segments: readonly ActivitySegment[];
  focusWeights?: Partial<FocusWeights>;
  /** Minimum length of a run to count as a focus block. Default 15 minutes. */
  minBlockMs?: number;
  /** A gap longer than this ends a focus block. Default 5 minutes. */
  blockGapMs?: number;
  /** Categories that may form a focus block. Default: categories with productivity > 0. */
  isBlockCategory?: (category: string) => boolean;
}

const HOUR_MS = 3_600_000;

export function aggregateDay(options: AggregateOptions): DayStats {
  const { rollups, segments } = options;
  const minBlockMs = options.minBlockMs ?? 15 * 60_000;
  const blockGapMs = options.blockGapMs ?? 5 * 60_000;
  const isBlockCategory = options.isBlockCategory ?? ((c: string) => categoryProductivity(c) > 0);

  // ---------------------------------------------------------------- accounts
  let activeMs = 0;
  let backgroundMs = 0;
  let idleMs = 0;
  let cpuMs = 0;
  let switches = 0;
  let peakMemBytes = 0;
  let firstSeen = Number.POSITIVE_INFINITY;
  let lastSeen = 0;

  const appMap = new Map<string, AppUsage>();
  const categoryMs = new Map<string, number>();
  const contextMs = new Map<string, number>();
  const minutesWithData = new Set<number>();
  const hourActive = new Array<number>(24).fill(0);
  const hourSwitches = new Array<number>(24).fill(0);
  const hourTopApp = new Map<number, Map<string, number>>();

  for (const row of rollups) {
    const rowEnd = row.minute + 60_000;
    if (row.minute < firstSeen) firstSeen = row.minute;
    if (rowEnd > lastSeen) lastSeen = rowEnd;

    if (row.app === AWAY_APP) {
      idleMs += row.awayMs;
      minutesWithData.add(row.minute);
      continue;
    }

    activeMs += row.foregroundMs;
    backgroundMs += row.backgroundMs;
    cpuMs += row.cpuMs;
    switches += row.switches;
    if (row.peakMemBytes > peakMemBytes) peakMemBytes = row.peakMemBytes;

    if (row.foregroundMs > 0 || row.backgroundMs > 0 || row.cpuMs > 0) minutesWithData.add(row.minute);

    let usage = appMap.get(row.app);
    if (!usage) {
      usage = {
        app: row.app,
        category: row.category,
        foregroundMs: 0,
        backgroundMs: 0,
        cpuMs: 0,
        peakMemBytes: 0,
        switches: 0,
        contexts: [],
      };
      appMap.set(row.app, usage);
    }
    usage.foregroundMs += row.foregroundMs;
    usage.backgroundMs += row.backgroundMs;
    usage.cpuMs += row.cpuMs;
    usage.switches += row.switches;
    if (row.peakMemBytes > usage.peakMemBytes) usage.peakMemBytes = row.peakMemBytes;

    if (row.foregroundMs > 0) {
      categoryMs.set(row.category, (categoryMs.get(row.category) ?? 0) + row.foregroundMs);
      if (row.context) contextMs.set(row.context, (contextMs.get(row.context) ?? 0) + row.foregroundMs);
    }
  }

  // Apps whose only appearance was background/CPU time still need a category.
  for (const row of rollups) {
    if (row.app === AWAY_APP) continue;
    const usage = appMap.get(row.app);
    if (usage && usage.foregroundMs === 0 && usage.category !== row.category && row.foregroundMs > 0) {
      usage.category = row.category;
    }
  }

  // -------- contexts per app (dominant context per minute is the proxy here;
  //          segments remain the exact source for context-level analysis) -----
  const appContexts = new Map<string, Map<string, number>>();
  for (const row of rollups) {
    if (row.app === AWAY_APP || row.foregroundMs <= 0 || !row.context) continue;
    let m = appContexts.get(row.app);
    if (!m) {
      m = new Map();
      appContexts.set(row.app, m);
    }
    m.set(row.context, (m.get(row.context) ?? 0) + row.foregroundMs);
  }

  // ------------------------------------------------------------ hour buckets
  for (const row of rollups) {
    if (row.app === AWAY_APP || row.foregroundMs <= 0) continue;
    const hour = localHour(row.minute);
    hourActive[hour] = (hourActive[hour] ?? 0) + row.foregroundMs;
    hourSwitches[hour] = (hourSwitches[hour] ?? 0) + row.switches;
    let top = hourTopApp.get(hour);
    if (!top) {
      top = new Map();
      hourTopApp.set(hour, top);
    }
    top.set(row.app, (top.get(row.app) ?? 0) + row.foregroundMs);
  }

  const apps: AppUsage[] = [...appMap.values()]
    .map((usage) => {
      const ctx = appContexts.get(usage.app);
      const contexts = ctx
        ? [...ctx.entries()]
            .map(([context, ms]) => ({ context, ms }))
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 8)
        : [];
      return { ...usage, contexts };
    })
    .sort((a, b) => b.foregroundMs + b.backgroundMs * 0.1 - (a.foregroundMs + a.backgroundMs * 0.1));

  const categories: CategoryUsage[] = [...categoryMs.entries()]
    .map(([category, ms]) => ({ category, ms, share: activeMs > 0 ? ms / activeMs : 0 }))
    .sort((a, b) => b.ms - a.ms);

  const hours: HourBucket[] = Array.from({ length: 24 }, (_, hour) => {
    const top = hourTopApp.get(hour);
    let topApp = '';
    let best = -1;
    if (top) {
      for (const [app, ms] of top) {
        if (ms > best) {
          best = ms;
          topApp = app;
        }
      }
    }
    return {
      hour,
      activeMs: hourActive[hour] ?? 0,
      foregroundMs: hourActive[hour] ?? 0,
      switches: hourSwitches[hour] ?? 0,
      topApp,
    };
  });

  // -------------------------------------------------------------- focus data
  const spanMs = lastSeen > firstSeen && Number.isFinite(firstSeen) ? lastSeen - firstSeen : 0;
  const deepMs = categoryMs.get('deep-work') ?? 0;
  let distractingMs = 0;
  for (const [category, ms] of categoryMs) {
    if (categoryProductivity(category) < 0) distractingMs += ms;
  }
  let weighted = 0;
  for (const [category, ms] of categoryMs) weighted += categoryProductivity(category) * ms;
  const qualityRatio = activeMs > 0 ? weighted / activeMs : 0;

  const topContexts = [...contextMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const top3ContextShare = activeMs > 0 ? topContexts.reduce((s, [, ms]) => s + ms, 0) / activeMs : 0;

  const totalMinutes = spanMs > 0 ? Math.floor(spanMs / 60_000) + 1 : 0;
  const sampleCoverage = totalMinutes > 0 ? Math.min(1, minutesWithData.size / totalMinutes) : 0;

  const blocks = detectFocusBlocks(segments, {
    minBlockMs,
    blockGapMs,
    isBlockCategory,
    focusWeights: options.focusWeights,
  });
  const longestBlockMs = blocks.reduce((max, b) => Math.max(max, b.end - b.start), 0);

  const focus = scoreFocus(
    {
      activeMs,
      spanMs,
      qualityRatio,
      deepMs,
      distractingMs,
      switches,
      longestBlockMin: longestBlockMs / 60_000,
      blockCount: blocks.length,
      top3ContextShare,
      sampleCoverage,
    },
    options.focusWeights ? { weights: options.focusWeights } : {},
  );

  return {
    deviceId: options.deviceId,
    day: options.day,
    firstSeen: Number.isFinite(firstSeen) ? firstSeen : 0,
    lastSeen,
    spanMs,
    activeMs,
    backgroundMs,
    idleMs,
    cpuMs,
    switches,
    apps,
    categories,
    hours,
    blocks,
    focus,
    longestBlockMs,
    peakMemBytes,
  };
}

export interface BlockOptions {
  minBlockMs: number;
  blockGapMs: number;
  isBlockCategory: (category: string) => boolean;
  focusWeights?: Partial<FocusWeights> | undefined;
}

/**
 * Group segments into focus blocks.
 *
 * A block is a run of positive-productivity segments with no gap longer than
 * `blockGapMs`, and no intervening non-work segment. Returning to the same
 * project after a two-minute look at chat is allowed; a twenty-minute video is not.
 */
export function detectFocusBlocks(
  segments: readonly ActivitySegment[],
  options: BlockOptions,
): FocusBlock[] {
  const sorted = [...segments]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const blocks: FocusBlock[] = [];

  let run: ActivitySegment[] = [];
  let runStart = 0;
  let runEnd = 0;

  const flush = (): void => {
    if (run.length === 0) return;
    const length = runEnd - runStart;
    if (length >= options.minBlockMs) {
      blocks.push(buildBlock(run, runStart, runEnd, options.focusWeights));
    }
    run = [];
  };

  for (const seg of sorted) {
    const isWork = options.isBlockCategory(seg.category);
    const gap = run.length > 0 ? seg.start - runEnd : 0;
    if (!isWork || (run.length > 0 && gap > options.blockGapMs)) {
      flush();
    }
    if (!isWork) continue;
    if (run.length === 0) {
      runStart = seg.start;
      runEnd = seg.end;
    } else {
      runEnd = Math.max(runEnd, seg.end);
    }
    run.push(seg);
  }
  flush();

  return blocks;
}

function buildBlock(
  segments: readonly ActivitySegment[],
  start: number,
  end: number,
  weights: Partial<FocusWeights> | undefined,
): FocusBlock {
  const contextMs = new Map<string, number>();
  const appMs = new Map<string, number>();
  const categoryMs = new Map<string, number>();
  let activeMs = 0;
  let switchCount = 0;
  let lastKey = '';

  for (const seg of segments) {
    const ms = seg.end - seg.start;
    activeMs += ms;
    if (seg.context) contextMs.set(seg.context, (contextMs.get(seg.context) ?? 0) + ms);
    appMs.set(seg.app, (appMs.get(seg.app) ?? 0) + ms);
    categoryMs.set(seg.category, (categoryMs.get(seg.category) ?? 0) + ms);
    const key = `${seg.app}\u0000${seg.context}`;
    if (key !== lastKey) {
      switchCount++;
      lastKey = key;
    }
  }

  let category = '';
  let bestCat = -1;
  for (const [c, ms] of categoryMs) {
    if (ms > bestCat) {
      bestCat = ms;
      category = c;
    }
  }

  const contexts = [...contextMs.entries()]
    .map(([context, ms]) => ({ context, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6);

  const span = Math.max(end - start, 1);
  let weighted = 0;
  for (const [c, ms] of categoryMs) weighted += categoryProductivity(c) * ms;
  const qualityRatio = activeMs > 0 ? weighted / activeMs : 0;
  const top3 = contexts.slice(0, 3).reduce((s, c) => s + c.ms, 0);
  const hours = activeMs / HOUR_MS;
  const summary = scoreFocus(
    {
      activeMs,
      spanMs: span,
      qualityRatio,
      deepMs: categoryMs.get('deep-work') ?? 0,
      distractingMs: 0,
      switches: Math.max(0, switchCount - 1),
      longestBlockMin: span / 60_000,
      blockCount: 1,
      top3ContextShare: activeMs > 0 ? top3 / activeMs : 0,
      sampleCoverage: 1,
    },
    weights ? { weights } : {},
  );

  const label = contexts[0]?.context ?? [...appMs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? categoryMeta(category).label;
  void hours;

  return {
    deviceId: segments[0]?.deviceId ?? '',
    start,
    end,
    activeMs,
    score: summary.score,
    category,
    contexts,
    apps: [...appMs.entries()].sort((a, b) => b[1] - a[1]).map(([app]) => app).slice(0, 8),
    switchCount: Math.max(0, switchCount - 1),
    label,
  };
}

/** Merge several devices' rollups for a cross-device ("both ends") view. */
export function mergeRollups(...groups: readonly RollupRow[][]): RollupRow[] {
  return groups.flat();
}
