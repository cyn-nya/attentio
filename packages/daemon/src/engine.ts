/**
 * The engine: the sampling loop and the only place that writes activity data.
 *
 * Responsibilities, kept deliberately narrow:
 *   - drive the collector on three independent cadences (window / process /
 *     window-inventory);
 *   - apply privacy exclusions *before* anything is classified or stored;
 *   - flush the accumulator into SQLite;
 *   - publish live state to subscribers (the SSE feed and the CLI);
 *   - enforce retention.
 *
 * It knows nothing about HTTP, reports or tasks — those read from the `Db`.
 */

import { ActivityAccumulator, RuleSet, mergeRules, DEFAULT_RULES } from '@attentio/shared';
import type {
  CategoryRule,
  Classification,
  CollectorStatus,
  LiveStatus,
  ProcessSample,
  RollupRow,
  RuleMatchInput,
  SystemSample,
  Task,
  WindowInventorySample,
  WindowSample,
} from '@attentio/shared';

import type { AttentioConfig } from './config.ts';
import type { Db } from './db/index.ts';
import type { Collector } from './collector/index.ts';

/** Reserved app for windows the user asked us never to record. */
export const PRIVATE_APP = '@private';

const FLUSH_INTERVAL_MS = 20_000;
const LIVE_INTERVAL_MS = 3000;
const RETENTION_CHECK_MS = 6 * 3_600_000;

export type EngineEvent = 'live' | 'day' | 'collector';

export interface EngineOptions {
  config: AttentioConfig;
  db: Db;
  collector: Collector;
  userRules?: CategoryRule[];
  /** Called when a new logical day starts, so the daemon can generate a report. */
  onNewDay?: (day: string) => void;
  /**
   * Clock seam. Tests drive the engine with a fake clock so minute accounting is
   * exact and does not depend on how fast the machine under test is.
   */
  now?: () => number;
}

interface Timers {
  window?: NodeJS.Timeout;
  process?: NodeJS.Timeout;
  inventory?: NodeJS.Timeout;
  flush?: NodeJS.Timeout;
  live?: NodeJS.Timeout;
  retention?: NodeJS.Timeout;
}

export class Engine {
  readonly db: Db;
  readonly collector: Collector;
  private config: AttentioConfig;
  private readonly accumulator: ActivityAccumulator;
  private readonly rules: RuleSet;
  private readonly timers: Timers = {};
  private readonly listeners = new Map<EngineEvent, Set<() => void>>();
  private readonly onNewDay: ((day: string) => void) | undefined;
  private readonly now: () => number;

  private running = false;
  private busy = { window: false, process: false, inventory: false, flush: false };
  private lastWindowAt = 0;
  private lastSystem: SystemSample | null = null;
  private lastTopCpu: { app: string; cpuPct: number; memBytes: number }[] = [];

  /**
   * Identity of this process, so the engine refuses to count itself. Matching on
   * the app name would be wrong: Attentio runs on Node, and so does every dev
   * server, MCP server and agent harness on this machine.
   */
  private readonly selfPid = process.pid;
  private readonly selfExe = process.execPath;
  private lastInventory: WindowInventorySample | null = null;
  private startedAt = 0;
  private errorCount = 0;
  private lastError = '';
  private currentLogicalDay = '';
  private flushedSegments = 0;
  private flushedRollups = 0;

  constructor(options: EngineOptions) {
    this.config = options.config;
    this.db = options.db;
    this.collector = options.collector;
    this.onNewDay = options.onNewDay;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.rules = new RuleSet(mergeRules(options.userRules ?? [], DEFAULT_RULES));
    this.accumulator = new ActivityAccumulator({
      deviceId: options.config.deviceId,
      classify: (input) => this.classify(input),
      idleThresholdMs: Math.max(30, options.config.tracking.idleThresholdSec) * 1000,
      maxGapMs: 10 * 60_000,
    });
  }

  // -------------------------------------------------------------- lifecycle
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.currentLogicalDay = new Date(this.now()).toDateString();

    const windowInterval = this.collector.recommendedSampleIntervalMs ?? this.config.tracking.sampleIntervalMs;

    // `running` is checked here rather than inside the tick methods, so tests can
    // drive `step()` directly without installing timers.
    this.timers.window = setInterval(() => {
      if (this.running) this.tickWindow();
    }, windowInterval);
    this.timers.process = setInterval(() => {
      if (this.running) this.tickProcesses();
    }, this.config.tracking.processIntervalMs);
    this.timers.inventory = setInterval(() => {
      if (this.running) this.tickInventory();
    }, this.config.tracking.inventoryIntervalMs);
    this.timers.flush = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timers.live = setInterval(() => this.emit('live'), LIVE_INTERVAL_MS);
    this.timers.retention = setInterval(() => this.prune(), RETENTION_CHECK_MS);

    // Prime the process baseline immediately so the first CPU reading is real
    // rather than a zero delta, and take one window sample so status is live.
    this.step();
    this.prune();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const timer of Object.values(this.timers)) if (timer) clearInterval(timer);
    for (const key of Object.keys(this.timers) as (keyof Timers)[]) delete this.timers[key];
    this.flush({ all: true });
    this.collector.dispose();
  }

  /** Force a flush of every buffered account; used before shutdown and by tests. */
  flush(options: { all?: boolean; now?: number } = {}): void {
    if (this.busy.flush) return;
    this.busy.flush = true;
    try {
      const now = options.now ?? this.now();
      const { segments, rollups } = this.accumulator.drain(now, { all: options.all === true });
      if (segments.length > 0) {
        this.db.insertSegments(segments);
        this.flushedSegments += segments.length;
      }
      if (rollups.length > 0) {
        this.db.insertRollups(rollups);
        this.flushedRollups += rollups.length;
      }
      this.db.touchDevice(this.config.deviceId, now);
    } catch (error) {
      this.noteError(error);
    } finally {
      this.busy.flush = false;
    }
  }

  // ------------------------------------------------------------------ ticks
  /**
   * One complete sampling cycle. The timers are only a scheduler around this, so
   * tests can drive the engine without waiting on wall-clock intervals.
   */
  step(): void {
    this.tickWindow();
    this.tickProcesses();
    this.tickInventory();
  }

  private tickWindow(): void {
    if (this.busy.window) return;
    this.busy.window = true;
    try {
      const now = this.now();
      const sample = this.collector.sampleWindow(now);
      if (sample) {
        this.lastWindowAt = now;
        // The engine stamps the timestamp: there is exactly one clock in the
        // accounting pipeline, so a collector reporting a stale or zero `ts`
        // cannot corrupt the timeline.
        this.accumulator.onWindow({ ...this.applyPrivacy(sample), ts: now });
        this.checkDayRollover(now);
      }
    } catch (error) {
      this.noteError(error);
    } finally {
      this.busy.window = false;
    }
  }

  private tickProcesses(): void {
    if (this.busy.process) return;
    this.busy.process = true;
    try {
      const now = this.now();
      // Never let Attentio count itself. Its own runtime is Node, and Node is
      // also what every dev server, MCP server and agent harness runs on, so
      // name-matching cannot separate us — identity can.
      const selfPid = this.selfPid;
      const samples: ProcessSample[] = this.collector
        .sampleProcesses(now)
        .filter((sample) => sample.pid !== selfPid && sample.exePath !== this.selfExe);
      if (samples.length > 0) this.accumulator.onProcesses(now, samples);
      const system = this.collector.sampleSystem(now);
      if (system) this.lastSystem = system;
      this.lastTopCpu = samples
        .filter((s) => s.cpuPct > 0.1)
        .sort((a, b) => b.cpuPct - a.cpuPct)
        .slice(0, 8)
        .map((s) => ({ app: s.app, cpuPct: Math.round(s.cpuPct * 10) / 10, memBytes: s.memBytes }));
    } catch (error) {
      this.noteError(error);
    } finally {
      this.busy.process = false;
    }
  }

  private tickInventory(): void {
    if (this.busy.inventory) return;
    this.busy.inventory = true;
    try {
      const inventory = this.collector.sampleInventory(this.now());
      if (inventory) {
        this.lastInventory = inventory;
        this.accumulator.onInventory(inventory);
      }
    } catch (error) {
      this.noteError(error);
    } finally {
      this.busy.inventory = false;
    }
  }

  // --------------------------------------------------------------- privacy
  /**
   * Excluded apps are folded into a single `@private` bucket rather than
   * dropped: dropping would leave holes in the day's totals and make the
   * numbers stop reconciling, which users read as a bug.
   */
  private applyPrivacy(sample: WindowSample): WindowSample {
    const tracking = this.config.tracking;
    const stem = sample.exePath.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? '';
    const app = sample.app.toLowerCase();

    const excludedApp = tracking.excludeApps.some((entry) => {
      const needle = entry.toLowerCase();
      return needle.length > 0 && (stem === needle || app === needle || stem.includes(needle));
    });

    const excludedTitle = tracking.excludeTitlePatterns.some((pattern) => {
      if (!pattern) return false;
      try {
        return new RegExp(pattern, 'i').test(sample.title);
      } catch {
        return false;
      }
    });

    if (!excludedApp && !excludedTitle) {
      return tracking.captureTitles ? sample : { ...sample, title: '' };
    }
    return { ...sample, app: PRIVATE_APP, exePath: '', title: '', elevated: false };
  }

  private classify(input: RuleMatchInput): Classification {
    if (input.app === PRIVATE_APP || input.stem === PRIVATE_APP) {
      return {
        category: 'system',
        ruleId: 'attentio.private',
        productivity: 0,
        note: 'excluded by your privacy rules — time is counted, content is not',
      };
    }
    return this.rules.classify(input);
  }

  // ------------------------------------------------------------------ days
  private checkDayRollover(now: number): void {
    const day = new Date(now).toDateString();
    if (day === this.currentLogicalDay) return;
    const previous = this.currentLogicalDay;
    this.currentLogicalDay = day;
    this.flush({ all: true });
    this.emit('day');
    void previous;
    this.onNewDay?.(dayKeyFromDate(new Date(now - 86_400_000)));
  }

  private prune(): void {
    const days = this.config.tracking.segmentRetentionDays;
    if (days <= 0) return;
    try {
      this.db.pruneSegments(this.now() - days * 86_400_000);
    } catch (error) {
      this.noteError(error);
    }
  }

  // ------------------------------------------------------------- live state
  status(): LiveStatus {
    const current = this.accumulator.isAway() ? null : this.accumulator.currentApp();
    const device = this.db.getDevice(this.config.deviceId);
    const upcoming = this.upcomingTasks();
    return {
      deviceId: this.config.deviceId,
      deviceName: device?.name ?? this.config.deviceName,
      platform: this.collector.platform,
      current,
      away: this.accumulator.isAway(),
      lastSampleAgeSec: this.lastWindowAt > 0 ? Math.round((this.now() - this.lastWindowAt) / 1000) : -1,
      cpuLoad: this.lastSystem?.cpuLoad ?? 0,
      memUsedBytes: this.lastSystem?.memUsedBytes ?? 0,
      memTotalBytes: this.lastSystem?.memTotalBytes ?? 0,
      topCpu: this.lastTopCpu,
      upcoming,
    };
  }

  private upcomingTasks(): Task[] {
    try {
      return this.db
        .listTasks({ status: 'all', limit: 200 })
        .filter((t) => (t.status === 'open' || t.status === 'doing') && t.dueAt !== null && t.dueAt < this.now() + 86_400_000)
        .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  collectorStatus(): CollectorStatus[] {
    return [this.collector.status()];
  }

  diagnostics(): Record<string, unknown> {
    return {
      running: this.running,
      platform: this.collector.platform,
      collector: this.collector.status(),
      rules: this.rules.size,
      flush: { segments: this.flushedSegments, rollups: this.flushedRollups },
      accumulator: { ...this.accumulator.stats, pendingBuckets: this.accumulator.pendingBuckets() },
      lastWindowAt: this.lastWindowAt,
      lastInventoryApps: this.lastInventory?.apps.length ?? 0,
      trackedProcessesRecently: this.lastTopCpu.length,
      errors: this.errorCount,
      lastError: this.lastError,
      uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
    };
  }

  /** Recent buffered data, for `attentio doctor --dump`. */
  peek(now = this.now()): { segments: number; rollups: RollupRow[] } {
    const snapshot = this.accumulator.drain(now, { all: true });
    // Put everything back: this is a read-only view.
    if (snapshot.segments.length > 0) this.db.insertSegments(snapshot.segments);
    if (snapshot.rollups.length > 0) this.db.insertRollups(snapshot.rollups);
    for (const segment of snapshot.segments) this.flushedSegments++;
    for (const rollup of snapshot.rollups) this.flushedRollups++;
    return { segments: snapshot.segments.length, rollups: snapshot.rollups };
  }

  // --------------------------------------------------------------- pub/sub
  on(event: EngineEvent, listener: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit(event: EngineEvent): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener();
      } catch {
        /* a broken subscriber must not stop the loop */
      }
    }
  }

  private noteError(error: unknown): void {
    this.errorCount++;
    this.lastError = error instanceof Error ? `${error.message}` : String(error);
  }
}

export function dayKeyFromDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
