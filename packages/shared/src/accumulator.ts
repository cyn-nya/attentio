/**
 * The activity accumulator — the heart of Attentio.
 *
 * It turns a stream of coarse observations (foreground window, idle time,
 * process CPU/memory, window inventory) into three precise, non-overlapping
 * accounts, which is the thing no other open-source tracker does in one place:
 *
 *   1. **engaged time** — the app was in front *and* the user was present;
 *   2. **background time** — the app was running with a visible window (or
 *      burning CPU) while something else was in front;
 *   3. **away time** — no input for longer than the idle threshold.
 *
 * For any instant of wall-clock time exactly one of "engaged in app X",
 * "running in background" or "away" accrues, so totals always reconcile.
 *
 * The class is I/O-free and time-injected, so the whole accounting model is
 * unit-testable by feeding it samples at chosen timestamps.
 */

import { MINUTE, floorToMinute } from './time.ts';
import { normalizeWindow, type NormalizedWindow } from './titlenorm.ts';
import type { Classification, RuleMatchInput } from './rules.ts';
import type {
  ActivitySegment,
  ProcessSample,
  RollupRow,
  WindowInventorySample,
  WindowSample,
} from './types.ts';

/** Reserved pseudo-app holding away-from-keyboard time. */
export const AWAY_APP = '@away';
/** Apps burning at least this much CPU count as running even without a window. */
export const BUSY_CPU_PCT = 1.0;
const DEFAULT_FLUSH_GRACE_MS = 15_000;

export interface ClassifyFn {
  (input: RuleMatchInput): Classification;
}

export interface AccumulatorOptions {
  deviceId: string;
  classify: ClassifyFn;
  /** No input for this long marks the user as away. Default 2 minutes. */
  idleThresholdMs?: number;
  /** Consecutive same-app segments closer than this merge into one. */
  mergeGapMs?: number;
  /** Hard cap on segment length so the timeline stays readable. */
  maxSegmentMs?: number;
  /** Sample gaps larger than this are treated as downtime, not activity. */
  maxGapMs?: number;
}

interface OpenSegment {
  app: string;
  exePath: string;
  context: string;
  detail: string;
  title: string;
  category: string;
  ruleId: string;
  start: number;
}

interface MutableRollup {
  minute: number;
  app: string;
  exePath: string;
  category: string;
  /** context -> ms, used to pick the dominant context at flush time. */
  contextMs: Map<string, number>;
  foregroundMs: number;
  backgroundMs: number;
  awayMs: number;
  cpuMs: number;
  peakMemBytes: number;
  switches: number;
}

interface AppMeta {
  exePath: string;
  category: string;
  ruleId: string;
}

function rowKey(minute: number, app: string, category: string): string {
  return `${minute}\u0000${app}\u0000${category}`;
}

export interface DrainResult {
  segments: ActivitySegment[];
  rollups: RollupRow[];
}

export class ActivityAccumulator {
  readonly deviceId: string;
  private readonly classify: ClassifyFn;
  private readonly idleThresholdMs: number;
  private readonly mergeGapMs: number;
  private readonly maxSegmentMs: number;
  private readonly maxGapMs: number;

  private lastTick = 0;
  private away = false;
  private current: OpenSegment | null = null;
  /** app\u0000context of the last foreground segment, for switch counting. */
  private lastForegroundKey = '';
  private lastClosedKey = '';
  private lastClosedEnd = 0;

  private readonly closedSegments: ActivitySegment[] = [];
  private readonly buckets = new Map<string, MutableRollup>();
  private readonly appMeta = new Map<string, AppMeta>();
  private readonly windowApps = new Set<string>();
  private readonly busyApps = new Set<string>();
  private lastProcess: { ts: number; byApp: Map<string, number> } | null = null;

  /** Diagnostics, surfaced by `attentio doctor`. */
  readonly stats = {
    windowSamples: 0,
    processSamples: 0,
    inventorySamples: 0,
    segmentsClosed: 0,
    droppedGapMs: 0,
  };

  constructor(options: AccumulatorOptions) {
    this.deviceId = options.deviceId;
    this.classify = options.classify;
    this.idleThresholdMs = options.idleThresholdMs ?? 120_000;
    this.mergeGapMs = options.mergeGapMs ?? 5_000;
    this.maxSegmentMs = options.maxSegmentMs ?? 45 * MINUTE;
    this.maxGapMs = options.maxGapMs ?? 10 * MINUTE;
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  onWindow(input: WindowSample): void {
    // A sample with no usable timestamp would corrupt the timeline.
    if (!Number.isFinite(input.ts) || input.ts <= 0) return;

    // The wall clock can step backwards — an NTP correction, a manual change, a
    // timezone edge case, or a collector that stamped the wrong thing. Time must
    // never flow backwards here: rewinding would either stall the tracker
    // forever or re-account minutes already counted, and silent double counting
    // is the one failure a time tracker cannot afford. Clamping the sample
    // forwards drops the rewound interval and resumes by itself once the wall
    // clock catches up again.
    const sample: WindowSample = input.ts < this.lastTick ? { ...input, ts: this.lastTick } : input;

    this.stats.windowSamples++;
    const normalized = normalizeWindow({ exePath: sample.exePath, title: sample.title, appHint: sample.app });
    const classification = this.classify({
      app: normalized.app,
      stem: normalized.stem,
      exePath: sample.exePath,
      title: sample.title,
    });
    this.rememberApp(normalized.app, sample.exePath, classification);

    // A gap this large means we were not running: the process slept, the
    // machine suspended, or it crashed. We have no evidence about that window,
    // so drop all of it. Crediting even a bounded slice would mean reporting
    // foreground time that nobody observed.
    if (this.lastTick > 0 && sample.ts - this.lastTick > this.maxGapMs) {
      this.stats.droppedGapMs += sample.ts - this.lastTick;
      this.closeCurrent(this.lastTick, true);
      this.away = true;
      this.lastTick = sample.ts;
    }

    if (sample.idleMs >= this.idleThresholdMs) {
      // The user actually stopped inputting at `ts - idleMs`, so attribute the
      // stretch before that to the app and start the away period there.
      const awayStart = Math.max(this.lastTick, sample.ts - sample.idleMs);
      this.advance(awayStart);
      if (!this.away) {
        this.closeCurrent(awayStart, true);
        this.away = true;
      }
      this.advance(sample.ts);
      return;
    }

    if (this.away) {
      this.away = false;
      this.advance(sample.ts);
      this.openSegment(sample.ts, sample, normalized, classification);
      return;
    }

    const cur = this.current;
    if (!cur) {
      this.advance(sample.ts);
      this.openSegment(sample.ts, sample, normalized, classification);
      return;
    }

    const changed =
      cur.app !== normalized.app || cur.context !== normalized.context || cur.category !== classification.category;

    if (changed) {
      this.advance(sample.ts);
      this.closeCurrent(sample.ts, false);
      this.openSegment(sample.ts, sample, normalized, classification);
      return;
    }

    if (sample.ts - cur.start > this.maxSegmentMs) {
      const splitAt = cur.start + this.maxSegmentMs;
      this.advance(splitAt);
      this.closeCurrent(splitAt, false);
      this.openSegment(splitAt, sample, normalized, classification);
      return;
    }

    // Same app and context: extend.
    cur.title = sample.title;
    cur.exePath = sample.exePath || cur.exePath;
    cur.detail = normalized.detail || cur.detail;
    this.advance(sample.ts);
  }

  onProcesses(ts: number, samples: readonly ProcessSample[]): void {
    if (!Number.isFinite(ts) || ts <= 0) return;
    this.stats.processSamples++;
    const prev = this.lastProcess;
    if (prev && ts > prev.ts) {
      const dt = ts - prev.ts;
      for (const [app, pct] of prev.byApp) {
        if (pct <= 0) continue;
        this.distributeCpu(app, (pct / 100) * dt, prev.ts, ts);
      }
    }

    const byApp = new Map<string, number>();
    this.busyApps.clear();
    for (const s of samples) {
      const meta = this.rememberApp(s.app, s.exePath, null);
      byApp.set(s.app, s.cpuPct);
      if (s.cpuPct >= BUSY_CPU_PCT) this.busyApps.add(s.app);
      if (s.memBytes > 0) {
        const row = this.row(floorToMinute(ts), s.app, meta.category);
        row.exePath = row.exePath || s.exePath;
        if (s.memBytes > row.peakMemBytes) row.peakMemBytes = s.memBytes;
      }
    }
    this.lastProcess = { ts, byApp };
  }

  onInventory(sample: WindowInventorySample): void {
    this.stats.inventorySamples++;
    this.windowApps.clear();
    for (const app of sample.apps) {
      if (!app) continue;
      this.windowApps.add(app);
      this.rememberApp(app, '', null);
    }
  }

  // -------------------------------------------------------------------------
  // Accounting
  // -------------------------------------------------------------------------

  /** Advance the books to `now`, attributing elapsed time to the current state. */
  advance(now: number): void {
    if (this.lastTick === 0) {
      this.lastTick = now;
      return;
    }
    if (now <= this.lastTick) return;
    let cursor = this.lastTick;
    while (cursor < now) {
      const chunkEnd = Math.min(now, floorToMinute(cursor) + MINUTE);
      this.accountChunk(cursor, chunkEnd);
      cursor = chunkEnd;
    }
    this.lastTick = now;
  }

  private accountChunk(from: number, to: number): void {
    const dt = to - from;
    if (dt <= 0) return;
    const minute = floorToMinute(from);

    if (this.away) {
      this.row(minute, AWAY_APP, 'idle').awayMs += dt;
      return;
    }

    const cur = this.current;
    if (cur) {
      const row = this.row(minute, cur.app, cur.category);
      row.foregroundMs += dt;
      row.exePath = row.exePath || cur.exePath;
      row.contextMs.set(cur.context, (row.contextMs.get(cur.context) ?? 0) + dt);
    }

    for (const app of this.runningApps()) {
      if (cur && app === cur.app) continue;
      const meta = this.appMeta.get(app);
      if (!meta) continue;
      const row = this.row(minute, app, meta.category);
      row.backgroundMs += dt;
      row.exePath = row.exePath || meta.exePath;
    }
  }

  /** Apps considered "running": any visible window, plus anything busy on CPU. */
  private runningApps(): Set<string> {
    const out = new Set<string>(this.windowApps);
    for (const app of this.busyApps) out.add(app);
    out.delete(AWAY_APP);
    return out;
  }

  private distributeCpu(app: string, cpuMs: number, from: number, to: number): void {
    if (cpuMs <= 0 || to <= from) return;
    const meta = this.appMeta.get(app) ?? this.rememberApp(app, '', null);
    const total = to - from;
    let cursor = from;
    while (cursor < to) {
      const chunkEnd = Math.min(to, floorToMinute(cursor) + MINUTE);
      this.row(floorToMinute(cursor), app, meta.category).cpuMs += cpuMs * ((chunkEnd - cursor) / total);
      cursor = chunkEnd;
    }
  }

  private row(minute: number, app: string, category: string): MutableRollup {
    const key = rowKey(minute, app, category);
    let row = this.buckets.get(key);
    if (!row) {
      row = {
        minute,
        app,
        exePath: '',
        category,
        contextMs: new Map(),
        foregroundMs: 0,
        backgroundMs: 0,
        awayMs: 0,
        cpuMs: 0,
        peakMemBytes: 0,
        switches: 0,
      };
      this.buckets.set(key, row);
    }
    return row;
  }

  private rememberApp(app: string, exePath: string, classification: Classification | null): AppMeta {
    let meta = this.appMeta.get(app);
    if (!meta) {
      const cls = classification ?? this.classify({ app, stem: app.toLowerCase(), exePath, title: '' });
      meta = { exePath, category: cls.category, ruleId: cls.ruleId };
      this.appMeta.set(app, meta);
    } else if (exePath && !meta.exePath) {
      meta.exePath = exePath;
    }
    return meta;
  }

  // -------------------------------------------------------------------------
  // Segments
  // -------------------------------------------------------------------------

  private openSegment(
    at: number,
    sample: WindowSample,
    normalized: NormalizedWindow,
    classification: Classification,
  ): void {
    const key = `${normalized.app}\u0000${normalized.context}`;
    this.current = {
      app: normalized.app,
      exePath: sample.exePath,
      context: normalized.context,
      detail: normalized.detail,
      title: sample.title,
      category: classification.category,
      ruleId: classification.ruleId,
      start: at,
    };

    if (key !== this.lastForegroundKey) {
      this.row(floorToMinute(at), normalized.app, classification.category).switches += 1;
      this.lastForegroundKey = key;
    }
  }

  private closeCurrent(end: number, idleEnd: boolean): void {
    const cur = this.current;
    this.current = null;
    if (!cur || end <= cur.start) return;

    const segment: ActivitySegment = {
      deviceId: this.deviceId,
      app: cur.app,
      exePath: cur.exePath,
      context: cur.context,
      detail: cur.detail,
      title: cur.title,
      category: cur.category,
      ruleId: cur.ruleId,
      start: cur.start,
      end,
      idleEnd,
    };

    const key = `${segment.app}\u0000${segment.context}\u0000${segment.category}`;
    const prev = this.closedSegments[this.closedSegments.length - 1];
    if (
      prev &&
      key === this.lastClosedKey &&
      segment.start - this.lastClosedEnd <= this.mergeGapMs &&
      segment.start - prev.end <= this.mergeGapMs
    ) {
      // Flicker between two windows of the same app and context: extend rather
      // than emit a hundred two-second segments.
      prev.end = segment.end;
      prev.idleEnd = idleEnd;
      if (segment.title) prev.title = segment.title;
      this.lastClosedEnd = segment.end;
      return;
    }

    this.closedSegments.push(segment);
    this.lastClosedKey = key;
    this.lastClosedEnd = segment.end;
    this.stats.segmentsClosed++;
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /**
   * Emit everything that is final. A completed minute only becomes final after
   * `flushGraceMs`, because a CPU sample that straddles a minute boundary can
   * still add to it.
   */
  drain(now: number, options: { all?: boolean; flushGraceMs?: number } = {}): DrainResult {
    const grace = options.flushGraceMs ?? DEFAULT_FLUSH_GRACE_MS;
    this.advance(now);

    if (options.all) this.closeCurrent(now, false);

    const cutoff = options.all === true ? Number.POSITIVE_INFINITY : now - grace;
    const rollups: RollupRow[] = [];
    for (const [key, row] of [...this.buckets]) {
      if (row.minute + MINUTE > cutoff) continue;
      this.buckets.delete(key);
      const anyAccount =
        row.foregroundMs > 0 || row.backgroundMs > 0 || row.awayMs > 0 || row.cpuMs > 0 || row.switches > 0;
      if (!anyAccount) continue;

      let dominant = '';
      let best = -1;
      for (const [context, ms] of row.contextMs) {
        if (ms > best) {
          best = ms;
          dominant = context;
        }
      }

      rollups.push({
        deviceId: this.deviceId,
        minute: row.minute,
        app: row.app,
        exePath: row.exePath,
        category: row.category,
        context: dominant,
        foregroundMs: Math.round(row.foregroundMs),
        backgroundMs: Math.round(row.backgroundMs),
        awayMs: Math.round(row.awayMs),
        cpuMs: Math.round(row.cpuMs),
        peakMemBytes: Math.round(row.peakMemBytes),
        switches: row.switches,
      });
    }
    rollups.sort((a, b) => a.minute - b.minute || a.app.localeCompare(b.app));

    const segments = this.closedSegments.splice(0, this.closedSegments.length);
    if (segments.length > 0) {
      this.lastClosedKey = '';
      this.lastClosedEnd = 0;
    }
    return { segments, rollups };
  }

  /** Current foreground app, for the live view and `attentio status`. */
  currentApp(): { app: string; context: string; category: string; since: number } | null {
    const cur = this.current;
    if (!cur) return null;
    return { app: cur.app, context: cur.context, category: cur.category, since: cur.start };
  }

  isAway(): boolean {
    return this.away;
  }

  /** Number of minute-buckets still held in memory (diagnostics). */
  pendingBuckets(): number {
    return this.buckets.size;
  }
}
