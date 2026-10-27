/**
 * Core domain types for Attentio.
 *
 * Layering contract:
 *   raw observations (WindowSample / ProcessSample)  ->  normalized segments & rollups
 *   ->  analytics (focus score, reports)
 *
 * Everything in this file must stay serializable: the same shapes cross the
 * daemon <-> web boundary over HTTP/SSE, so no Date objects, no class instances.
 * All timestamps are epoch milliseconds in the collecting device's clock.
 */

/** Where a stream of activity came from. */
export type Platform = 'win32' | 'darwin' | 'linux' | 'android' | 'harmony' | 'web' | 'unknown';

/** A machine or client that reports activity. */
export interface Device {
  id: string;
  /** Human label, e.g. "XDDDC (Windows laptop)". */
  name: string;
  platform: Platform;
  /** Free-form hostname / model, used for display only. */
  hostname: string;
  createdAt: number;
  lastSeenAt: number;
  /** False once the user revokes it from the daemon. */
  trusted: boolean;
}

// ---------------------------------------------------------------------------
// Raw observations
// ---------------------------------------------------------------------------

/** One foreground-window observation. Emitted on change and on a heartbeat. */
export interface WindowSample {
  ts: number;
  /** Normalized application name, e.g. `Code`, `chrome`, `WeChat`. */
  app: string;
  /** Full path of the owning executable when the OS lets us resolve it. */
  exePath: string;
  pid: number;
  /** Raw window title, untrimmed. May contain sensitive text; see privacy policy. */
  title: string;
  /** System-wide milliseconds since the last keyboard/mouse input. */
  idleMs: number;
  /** True when the foreground window is not owned by a normal app (lock screen, UAC). */
  elevated: boolean;
}

/** Per-process resource observation. `cpuPct` is relative to a single core. */
export interface ProcessSample {
  ts: number;
  app: string;
  exePath: string;
  pid: number;
  cpuPct: number;
  memBytes: number;
}

/**
 * Inventory of applications that currently own at least one visible top-level
 * window. This is what lets Attentio separate *foreground* time from
 * *background* time: an app can be open for six hours and used for twenty
 * minutes, and both numbers are interesting.
 */
export interface WindowInventorySample {
  ts: number;
  apps: string[];
  windowCount: number;
}

/** Aggregate system load, sampled alongside processes. */
export interface SystemSample {
  ts: number;
  /** 0..1 normalized load across all cores. */
  cpuLoad: number;
  memUsedBytes: number;
  memTotalBytes: number;
  /** Seconds of uptime. */
  uptimeSec: number;
}

// ---------------------------------------------------------------------------
// Derived activity model
// ---------------------------------------------------------------------------

/**
 * A contiguous stretch of time attributed to one app + context.
 * Segment boundaries are produced by the sessionizer from raw window samples.
 */
export interface ActivitySegment {
  id?: number;
  deviceId: string;
  app: string;
  exePath: string;
  /** Sub-app context such as a project, repository, or page title. */
  context: string;
  /** Secondary detail such as the file name, when the app exposes one. */
  detail: string;
  /** Representative raw title for the segment (the one held longest). */
  title: string;
  category: string;
  /** Rule id that produced the category, for explainability. */
  ruleId: string;
  start: number;
  end: number;
  /** True when the segment ended because the user went idle rather than switching. */
  idleEnd: boolean;
}

/**
 * Minute-granularity rollup. This is the workhorse table: daily summaries,
 * trends and diagnostics are all computed from it, and it is small enough to
 * keep forever (a busy day is a few thousand rows).
 */
export interface RollupRow {
  deviceId: string;
  /** Epoch ms floored to the minute. */
  minute: number;
  app: string;
  exePath: string;
  category: string;
  context: string;
  /** Milliseconds this app was the foreground window during the minute. */
  foregroundMs: number;
  /** Milliseconds this app was running but not foreground. */
  backgroundMs: number;
  /**
   * Milliseconds the user was away from the keyboard during the minute.
   * Only ever non-zero on the reserved `@away` row, so `sum(awayMs)` is the
   * day's total idle time and the three accounts never double count.
   */
  awayMs: number;
  /** CPU milliseconds consumed by this app during the minute. */
  cpuMs: number;
  peakMemBytes: number;
  /** How many times this app became the foreground window during the minute. */
  switches: number;
}

/** A detected focus block: a run of deep, uninterrupted work. */
export interface FocusBlock {
  deviceId: string;
  start: number;
  end: number;
  /** Milliseconds actually engaged (idle removed). */
  activeMs: number;
  score: number;
  /** Dominant category during the block. */
  category: string;
  /** Top contexts by time inside the block. */
  contexts: { context: string; ms: number }[];
  apps: string[];
  switchCount: number;
  label: string;
}

/** A generated narrative artifact (daily log, diagnostic, weekly review). */
export interface ReportRecord {
  id: number;
  deviceId: string;
  /** Local day key `YYYY-MM-DD` the report covers (its start day). */
  day: string;
  kind: ReportKind;
  /** Deterministic statistics always present, LLM or not. */
  stats: DayStats;
  /** Model-written narrative, absent when no LLM is configured. */
  narrative?: string;
  model?: string;
  createdAt: number;
  /** True when the narrative was written from redacted input only. */
  redacted: boolean;
}

export type ReportKind = 'daily' | 'weekly' | 'diagnostic';

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface AppUsage {
  app: string;
  category: string;
  foregroundMs: number;
  backgroundMs: number;
  cpuMs: number;
  peakMemBytes: number;
  switches: number;
  /** Dominant contexts, descending by time. */
  contexts: { context: string; ms: number }[];
}

export interface CategoryUsage {
  category: string;
  ms: number;
  share: number;
}

export interface HourBucket {
  /** 0..23 local hour. */
  hour: number;
  activeMs: number;
  foregroundMs: number;
  switches: number;
  topApp: string;
}

export interface DayStats {
  deviceId: string;
  day: string;
  /** Calendar span covered by data (first to last observation). */
  firstSeen: number;
  lastSeen: number;
  /** Wall-clock ms between first and last observation. */
  spanMs: number;
  /** Non-idle, non-locked foreground time. */
  activeMs: number;
  /** Time attributed to apps running in the background. */
  backgroundMs: number;
  /** Time the machine was on but the user was away/idle. */
  idleMs: number;
  /** Total CPU milliseconds consumed across all processes. */
  cpuMs: number;
  switches: number;
  apps: AppUsage[];
  categories: CategoryUsage[];
  hours: HourBucket[];
  blocks: FocusBlock[];
  focus: FocusSummary;
  /** Longest continuous engagement in the day. */
  longestBlockMs: number;
  peakMemBytes: number;
}

export interface FocusSummary {
  /** 0..100 weighted score for the whole day. */
  score: number;
  grade: FocusGrade;
  factors: FocusFactor[];
  confidence: number;
  notes: string[];
}

export type FocusGrade = 'A' | 'B' | 'C' | 'D';

export interface FocusFactor {
  id: string;
  label: string;
  /** Chinese label, so a zh report does not fall back to English. */
  labelZh?: string;
  /** 0..1 normalized quality of this factor. */
  value: number;
  weight: number;
  /** Signed points this factor added to (or removed from) the final score. */
  contribution: number;
  /** Human-readable explanation, always populated. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Tasks and journal
// ---------------------------------------------------------------------------

export type TaskStatus = 'open' | 'doing' | 'done' | 'dropped';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Task {
  id: number;
  deviceId: string;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Epoch ms, or null when the task has no deadline. */
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** `user`, `voice`, or `ai`. */
  source: string;
  tags: string[];
  /** Optional free-form estimate in minutes. */
  estimateMin: number | null;
  /** Set when a reminder was last delivered. */
  remindedAt: number | null;
}

export interface JournalEntry {
  id: number;
  deviceId: string;
  /** Epoch ms of the start of the period this entry describes. */
  start: number;
  end: number;
  text: string;
  /** `user` | `ai` | `imported`. */
  source: string;
  tags: string[];
  createdAt: number;
  /** Set when this entry was generated by the daily-report pipeline. */
  reportId: number | null;
}

// ---------------------------------------------------------------------------
// Collector diagnostics
// ---------------------------------------------------------------------------

export type CollectorHealth = 'ok' | 'degraded' | 'unavailable';

export interface CollectorStatus {
  id: string;
  platform: Platform;
  health: CollectorHealth;
  /** One-line explanation of what it can and cannot see. */
  detail: string;
  capabilities: {
    foregroundWindow: boolean;
    windowTitles: boolean;
    idleTime: boolean;
    perProcessCpu: boolean;
    perProcessMemory: boolean;
    backgroundInventory: boolean;
    inputActivity: boolean;
  };
}
