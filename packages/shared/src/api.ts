/**
 * The HTTP contract between the daemon and every client (web PWA, CLI, and
 * future native mobile agents).
 *
 * Both sides import these types, so a breaking change is a compile error rather
 * than a runtime surprise. Requests and responses are plain JSON; the only
 * streaming endpoint is `/api/events` (Server-Sent Events), chosen over
 * WebSockets because it needs no extra dependency and survives phone sleep.
 */

import type {
  ActivitySegment,
  CollectorStatus,
  DayStats,
  Device,
  FocusBlock,
  JournalEntry,
  RedactionLevel,
  ReportKind,
  ReportRecord,
  Task,
  TaskPriority,
  TaskStatus,
} from './types.ts';

export const API_PREFIX = '/api';
export const SSE_PATH = '/api/events';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Optional hint the UI can show verbatim. */
    hint?: string;
  };
}

export interface HealthResponse {
  ok: true;
  version: string;
  /** Seconds since the daemon started. */
  uptimeSec: number;
  /** True when an LLM provider is configured. */
  aiEnabled: boolean;
  collectors: CollectorStatus[];
}

export interface LiveStatus {
  deviceId: string;
  deviceName: string;
  platform: string;
  /** Foreground app right now, or null when away. */
  current: { app: string; context: string; category: string; since: number } | null;
  away: boolean;
  /** Seconds since the last sample reached the accumulator. */
  lastSampleAgeSec: number;
  /** Rolling 1-minute CPU load, 0..1. */
  cpuLoad: number;
  memUsedBytes: number;
  memTotalBytes: number;
  /** Top apps by CPU over the last minute. */
  topCpu: { app: string; cpuPct: number; memBytes: number }[];
  /** Tasks due within the next 24h, soonest first. */
  upcoming: Task[];
}

export interface DevicesResponse {
  devices: Device[];
}

export interface DayQuery {
  /** Local day key `YYYY-MM-DD`. Defaults to today. */
  day?: string;
  /** Omit to merge every trusted device. */
  deviceId?: string;
  focusPreset?: 'balanced' | 'deep' | 'calm';
}

export interface DayResponse {
  day: string;
  /** Merged stats across the selected devices. */
  stats: DayStats;
  /** Per-device breakdown so the phone can show "laptop vs phone". */
  perDevice: DayStats[];
  devices: Device[];
  /** Rollups are included so the client can recompute charts without a round trip. */
  rollupsIncluded: boolean;
}

export interface TimelineQuery {
  day?: string;
  deviceId?: string;
  /** Cap the number of returned segments (newest kept). Default 2000. */
  limit?: number;
}

export interface TimelineResponse {
  day: string;
  segments: ActivitySegment[];
  truncated: boolean;
}

export interface TrendPoint {
  day: string;
  activeMs: number;
  deepMs: number;
  distractingMs: number;
  idleMs: number;
  cpuMs: number;
  switches: number;
  score: number;
  topApp: string;
}

export interface TrendResponse {
  days: TrendPoint[];
  /** Per-day app totals, only populated when `apps=1`. */
  byApp?: { day: string; app: string; foregroundMs: number }[];
}

export interface BlocksResponse {
  day: string;
  blocks: FocusBlock[];
  minBlockMs: number;
}

export interface ReportsResponse {
  reports: ReportRecord[];
}

/**
 * Exactly what an AI report would transmit, so the user can read it first.
 *
 * This type exists because "we redact before sending" is not a promise anyone
 * can check. The preview is the check: it is a read-only route, and the payload
 * it returns is produced by the same function the sender uses.
 */
export interface ReportPreviewResponse {
  /** The literal JSON body that would be posted to the model. */
  payload: Record<string, unknown>;
  level: RedactionLevel;
  /** Serialised size, because "a summary" should have a number attached. */
  bytes: number;
  /** Where it would go. Null when no provider is configured. */
  endpoint: string | null;
  model: string;
  aiEnabled: boolean;
}

export interface GenerateReportRequest {
  day?: string;
  kind?: ReportKind;
  /** Skip the LLM even when one is configured. */
  statsOnly?: boolean;
  /** Extra instructions for the model, e.g. "focus on why afternoons collapse". */
  instruction?: string;
}

export interface TasksQuery {
  status?: TaskStatus | 'all';
  /** Only tasks due before this epoch ms. */
  dueBefore?: number;
  tag?: string;
}

export interface TasksResponse {
  tasks: Task[];
}

export interface CreateTaskRequest {
  title: string;
  notes?: string;
  priority?: TaskPriority;
  /** Epoch ms, or an ISO date string. */
  dueAt?: number | string | null;
  tags?: string[];
  estimateMin?: number;
  /** `user` | `voice` | `ai`. */
  source?: string;
}

export interface UpdateTaskRequest {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueAt?: number | string | null;
  tags?: string[];
  estimateMin?: number | null;
}

export interface JournalQuery {
  day?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface JournalResponse {
  entries: JournalEntry[];
}

export interface CreateJournalRequest {
  text: string;
  /** Epoch ms or ISO string; defaults to the last 30 minutes. */
  start?: number | string;
  end?: number | string;
  tags?: string[];
  source?: string;
}

/** Settings that a remote client is allowed to read and change. */
export interface PublicSettings {
  /** Never sent to a client; only `hasApiKey` is exposed. */
  ai: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    hasApiKey: boolean;
    /**
     * What a model call may include. `app` sends app names, categories and
     * timings; `context` adds project, page and document names.
     *
     * There is deliberately no level that sends raw window titles: the title is
     * reduced by `titlenorm.ts` before it is ever stored, so a "full" level
     * could only promise something the pipeline has already discarded.
     */
    redaction: RedactionLevel;
    /** Local hour (0-23) at which the daily report is generated, or -1 for off. */
    dailyReportHour: number;
    /** Whether the automatic daily report may call the model without being asked. */
    autoReports: boolean;
    language: 'en' | 'zh';
  };
  tracking: {
    idleThresholdSec: number;
    sampleIntervalMs: number;
    processIntervalMs: number;
    /** Retention for raw segments, in days. 0 keeps everything. */
    segmentRetentionDays: number;
    captureTitles: boolean;
    excludeApps: string[];
    excludeTitlePatterns: string[];
    /** Minutes before a due time to remind about a task. */
    reminderLeadMin: number;
    /**
     * Local hour at which a new day begins. The dashboard needs this to know
     * which day key is "today" — without it a late-night session would be filed
     * under the wrong date by exactly one day.
     */
    dayStartHour: number;
  };
  focus: {
    preset: 'balanced' | 'deep' | 'calm' | 'custom';
    weights: { engagement: number; depth: number; continuity: number; fragmentation: number; coherence: number };
    minBlockMin: number;
  };
  ui: {
    theme: 'system' | 'light' | 'dark';
    locale: 'en' | 'zh';
    petEnabled: boolean;
    petSkin: string;
    fontScale: number;
    fontFamily: string;
  };
  remote: {
    bindHost: string;
    port: number;
    /** True when the daemon is reachable beyond localhost. */
    enabled: boolean;
  };
}

export type UpdateSettingsRequest = {
  [K in keyof PublicSettings]?: Partial<PublicSettings[K]>;
};

export interface PairRequest {
  /** Short code shown in the daemon terminal. */
  code: string;
  deviceName: string;
  platform: string;
}

export interface PairResponse {
  token: string;
  device: Device;
  /** Absolute URL the phone should use from now on. */
  apiBase: string;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export type SseEvent =
  | { type: 'hello'; at: number; deviceId: string; version: string }
  | { type: 'live'; at: number; status: LiveStatus }
  | { type: 'day'; at: number; day: string }
  | { type: 'task'; at: number; task: Task; action: 'created' | 'updated' | 'deleted' | 'completed' }
  | { type: 'report'; at: number; report: ReportRecord }
  | { type: 'reminder'; at: number; task: Task; message: string }
  | { type: 'heartbeat'; at: number };

export function sseFrame(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
