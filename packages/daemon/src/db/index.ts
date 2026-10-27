/**
 * SQLite persistence.
 *
 * Uses Node's built-in `node:sqlite`, so Attentio has **no native build step**
 * and no `better-sqlite3`-style toolchain requirement — a deliberate choice for
 * a project that wants contributors on Windows without MSVC installed.
 *
 * Storage shape:
 *   - `segments`  raw timeline, prunable (default 90 days);
 *   - `rollups`   minute-level accounts, kept forever, additive upsert;
 *   - `tasks` / `journal` / `reports` — the human-facing layer.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  ActivitySegment,
  Device,
  JournalEntry,
  Platform,
  ReportKind,
  ReportRecord,
  RollupRow,
  Task,
  TaskPriority,
  TaskStatus,
} from '@attentio/shared';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  hostname     TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  trusted      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  app        TEXT NOT NULL,
  exe_path   TEXT NOT NULL DEFAULT '',
  context    TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL,
  rule_id    TEXT NOT NULL DEFAULT '',
  start      INTEGER NOT NULL,
  end        INTEGER NOT NULL,
  idle_end   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_segments_start ON segments(start);
CREATE INDEX IF NOT EXISTS idx_segments_device_start ON segments(device_id, start);

CREATE TABLE IF NOT EXISTS rollups (
  device_id       TEXT NOT NULL,
  minute          INTEGER NOT NULL,
  app             TEXT NOT NULL,
  exe_path        TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL,
  context         TEXT NOT NULL DEFAULT '',
  foreground_ms   INTEGER NOT NULL DEFAULT 0,
  background_ms   INTEGER NOT NULL DEFAULT 0,
  away_ms         INTEGER NOT NULL DEFAULT 0,
  cpu_ms          INTEGER NOT NULL DEFAULT 0,
  peak_mem_bytes  INTEGER NOT NULL DEFAULT 0,
  switches        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, minute, app, category)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_rollups_minute ON rollups(minute);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL,
  title         TEXT NOT NULL,
  notes         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',
  priority      TEXT NOT NULL DEFAULT 'normal',
  due_at        INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  source        TEXT NOT NULL DEFAULT 'user',
  tags          TEXT NOT NULL DEFAULT '[]',
  estimate_min  INTEGER,
  reminded_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);

CREATE TABLE IF NOT EXISTS journal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  start       INTEGER NOT NULL,
  end         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'user',
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  report_id   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_journal_start ON journal(start);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  day         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  stats       TEXT NOT NULL,
  narrative   TEXT,
  model       TEXT,
  created_at  INTEGER NOT NULL,
  redacted    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (device_id, day, kind)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token        TEXT PRIMARY KEY,
  label        TEXT NOT NULL DEFAULT '',
  device_id    TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pairing (
  code        TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  device_name TEXT
);
`;

export interface RollupQuery {
  from: number;
  to: number;
  deviceId?: string | undefined;
}

export interface SegmentQuery extends RollupQuery {
  limit?: number;
}

export class Db {
  readonly db: DatabaseSync;
  readonly file: string;
  private readonly cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.file = file;
    if (file !== ':memory:') {
      const dir = dirname(file);
      mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA);
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const current = row?.user_version ?? 0;
    if (current < SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }

  // ---------------------------------------------------------------- devices
  upsertDevice(device: Device): void {
    this.stmt(
      `INSERT INTO devices (id, name, platform, hostname, created_at, last_seen_at, trusted)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         platform = excluded.platform,
         hostname = excluded.hostname,
         last_seen_at = excluded.last_seen_at,
         trusted = excluded.trusted`,
    ).run(
      device.id,
      device.name,
      device.platform,
      device.hostname,
      device.createdAt,
      device.lastSeenAt,
      device.trusted ? 1 : 0,
    );
  }

  listDevices(): Device[] {
    const rows = this.stmt('SELECT * FROM devices ORDER BY last_seen_at DESC').all() as unknown as DeviceRow[];
    return rows.map(mapDevice);
  }

  getDevice(id: string): Device | null {
    const row = this.stmt('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow | undefined;
    return row ? mapDevice(row) : null;
  }

  touchDevice(id: string, at: number): void {
    this.stmt('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  // --------------------------------------------------------------- activity
  insertSegments(segments: readonly ActivitySegment[]): void {
    if (segments.length === 0) return;
    const s = this.stmt(
      `INSERT INTO segments (device_id, app, exe_path, context, detail, title, category, rule_id, start, end, idle_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.tx(() => {
      for (const seg of segments) {
        s.run(
          seg.deviceId,
          seg.app,
          seg.exePath,
          seg.context,
          seg.detail,
          seg.title,
          seg.category,
          seg.ruleId,
          seg.start,
          seg.end,
          seg.idleEnd ? 1 : 0,
        );
      }
    });
  }

  /**
   * Additive upsert: rollups accumulate. The accumulator guarantees a minute is
   * emitted exactly once per observation, so additions never double count.
   */
  insertRollups(rows: readonly RollupRow[]): void {
    if (rows.length === 0) return;
    const s = this.stmt(
      `INSERT INTO rollups (device_id, minute, app, exe_path, category, context,
                            foreground_ms, background_ms, away_ms, cpu_ms, peak_mem_bytes, switches)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, minute, app, category) DO UPDATE SET
         foreground_ms  = foreground_ms  + excluded.foreground_ms,
         background_ms  = background_ms  + excluded.background_ms,
         away_ms        = away_ms        + excluded.away_ms,
         cpu_ms         = cpu_ms         + excluded.cpu_ms,
         peak_mem_bytes = MAX(peak_mem_bytes, excluded.peak_mem_bytes),
         switches       = switches       + excluded.switches,
         context        = CASE WHEN excluded.foreground_ms > 0 THEN excluded.context ELSE context END,
         exe_path       = CASE WHEN exe_path = '' THEN excluded.exe_path ELSE exe_path END`,
    );
    this.tx(() => {
      for (const row of rows) {
        s.run(
          row.deviceId,
          row.minute,
          row.app,
          row.exePath,
          row.category,
          row.context,
          row.foregroundMs,
          row.backgroundMs,
          row.awayMs,
          row.cpuMs,
          row.peakMemBytes,
          row.switches,
        );
      }
    });
  }

  queryRollups(query: RollupQuery): RollupRow[] {
    const rows = query.deviceId
      ? (this.stmt(
          'SELECT * FROM rollups WHERE minute >= ? AND minute < ? AND device_id = ? ORDER BY minute',
        ).all(query.from, query.to, query.deviceId) as unknown as RollupDbRow[])
      : (this.stmt('SELECT * FROM rollups WHERE minute >= ? AND minute < ? ORDER BY minute').all(
          query.from,
          query.to,
        ) as unknown as RollupDbRow[]);
    return rows.map(mapRollup);
  }

  querySegments(query: SegmentQuery): ActivitySegment[] {
    const limit = query.limit ?? 5000;
    const rows = query.deviceId
      ? (this.stmt(
          `SELECT * FROM segments WHERE start >= ? AND start < ? AND device_id = ?
           ORDER BY start DESC LIMIT ?`,
        ).all(query.from, query.to, query.deviceId, limit) as unknown as SegmentRow[])
      : (this.stmt(
          'SELECT * FROM segments WHERE start >= ? AND start < ? ORDER BY start DESC LIMIT ?',
        ).all(query.from, query.to, limit) as unknown as SegmentRow[]);
    return rows.map(mapSegment).reverse();
  }

  countSegments(from: number, to: number, deviceId?: string): number {
    const row = deviceId
      ? (this.stmt('SELECT COUNT(*) AS n FROM segments WHERE start >= ? AND start < ? AND device_id = ?').get(
          from,
          to,
          deviceId,
        ) as { n: number })
      : (this.stmt('SELECT COUNT(*) AS n FROM segments WHERE start >= ? AND start < ?').get(from, to) as {
          n: number;
        });
    return row.n;
  }

  pruneSegments(before: number): number {
    const result = this.stmt('DELETE FROM segments WHERE end < ?').run(before);
    return Number(result.changes);
  }

  /** Earliest minute we have any data for — drives "first run" messaging. */
  firstDataAt(): number | null {
    const row = this.stmt('SELECT MIN(minute) AS m FROM rollups').get() as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  // ----------------------------------------------------------------- tasks
  createTask(task: Omit<Task, 'id'>): Task {
    const result = this.stmt(
      `INSERT INTO tasks (device_id, title, notes, status, priority, due_at, created_at, updated_at,
                          completed_at, source, tags, estimate_min, reminded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.deviceId,
      task.title,
      task.notes,
      task.status,
      task.priority,
      task.dueAt,
      task.createdAt,
      task.updatedAt,
      task.completedAt,
      task.source,
      JSON.stringify(task.tags),
      task.estimateMin,
      task.remindedAt,
    );
    return { ...task, id: Number(result.lastInsertRowid) };
  }

  updateTask(id: number, patch: Partial<Omit<Task, 'id' | 'deviceId'>>): Task | null {
    const existing = this.getTask(id);
    if (!existing) return null;
    const merged: Task = { ...existing, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    this.stmt(
      `UPDATE tasks SET title=?, notes=?, status=?, priority=?, due_at=?, updated_at=?,
                        completed_at=?, source=?, tags=?, estimate_min=?, reminded_at=?
       WHERE id = ?`,
    ).run(
      merged.title,
      merged.notes,
      merged.status,
      merged.priority,
      merged.dueAt,
      merged.updatedAt,
      merged.completedAt,
      merged.source,
      JSON.stringify(merged.tags),
      merged.estimateMin,
      merged.remindedAt,
      id,
    );
    return merged;
  }

  getTask(id: number): Task | null {
    const row = this.stmt('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  listTasks(filter: { status?: TaskStatus | 'all'; dueBefore?: number; tag?: string; limit?: number } = {}): Task[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status && filter.status !== 'all') {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.dueBefore !== undefined) {
      clauses.push('due_at IS NOT NULL AND due_at < ?');
      params.push(filter.dueBefore);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.stmt(
      `SELECT * FROM tasks ${where}
       ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'open' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                due_at IS NULL, due_at, priority DESC, created_at DESC
       LIMIT ?`,
    ).all(...params, filter.limit ?? 500) as unknown as TaskRow[];
    const tasks = rows.map(mapTask);
    return filter.tag ? tasks.filter((t) => t.tags.includes(filter.tag as string)) : tasks;
  }

  deleteTask(id: number): boolean {
    return Number(this.stmt('DELETE FROM tasks WHERE id = ?').run(id).changes) > 0;
  }

  /** Open tasks whose reminder is due. */
  dueReminders(now: number, leadMs: number): Task[] {
    const rows = this.stmt(
      `SELECT * FROM tasks
       WHERE status IN ('open', 'doing') AND due_at IS NOT NULL AND due_at <= ?
         AND (reminded_at IS NULL OR reminded_at < due_at - ?)
       ORDER BY due_at`,
    ).all(now + leadMs, leadMs) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  // --------------------------------------------------------------- journal
  createJournal(entry: Omit<JournalEntry, 'id'>): JournalEntry {
    const result = this.stmt(
      `INSERT INTO journal (device_id, start, end, text, source, tags, created_at, report_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.deviceId,
      entry.start,
      entry.end,
      entry.text,
      entry.source,
      JSON.stringify(entry.tags),
      entry.createdAt,
      entry.reportId,
    );
    return { ...entry, id: Number(result.lastInsertRowid) };
  }

  listJournal(query: { from?: number; to?: number; limit?: number } = {}): JournalEntry[] {
    const from = query.from ?? 0;
    const to = query.to ?? Number.MAX_SAFE_INTEGER;
    const rows = this.stmt(
      'SELECT * FROM journal WHERE start >= ? AND start < ? ORDER BY start DESC LIMIT ?',
    ).all(from, to, query.limit ?? 200) as unknown as JournalRow[];
    return rows.map(mapJournal);
  }

  deleteJournal(id: number): boolean {
    return Number(this.stmt('DELETE FROM journal WHERE id = ?').run(id).changes) > 0;
  }

  // --------------------------------------------------------------- reports
  saveReport(report: Omit<ReportRecord, 'id'>, options: { replace?: boolean } = {}): ReportRecord {
    const sql = options.replace
      ? `INSERT INTO reports (device_id, day, kind, stats, narrative, model, created_at, redacted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, day, kind) DO UPDATE SET
           stats = excluded.stats, narrative = excluded.narrative, model = excluded.model,
           created_at = excluded.created_at, redacted = excluded.redacted`
      : `INSERT INTO reports (device_id, day, kind, stats, narrative, model, created_at, redacted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const result = this.stmt(sql).run(
      report.deviceId,
      report.day,
      report.kind,
      JSON.stringify(report.stats),
      report.narrative ?? null,
      report.model ?? null,
      report.createdAt,
      report.redacted ? 1 : 0,
    );
    const row = this.stmt('SELECT * FROM reports WHERE device_id = ? AND day = ? AND kind = ?').get(
      report.deviceId,
      report.day,
      report.kind,
    ) as unknown as ReportRow;
    void result;
    return mapReport(row);
  }

  getReport(deviceId: string, day: string, kind: ReportKind): ReportRecord | null {
    const row = this.stmt('SELECT * FROM reports WHERE device_id = ? AND day = ? AND kind = ?').get(
      deviceId,
      day,
      kind,
    ) as unknown as ReportRow | undefined;
    return row ? mapReport(row) : null;
  }

  listReports(query: { deviceId?: string; kind?: ReportKind; limit?: number } = {}): ReportRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.deviceId) {
      clauses.push('device_id = ?');
      params.push(query.deviceId);
    }
    if (query.kind) {
      clauses.push('kind = ?');
      params.push(query.kind);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.stmt(`SELECT * FROM reports ${where} ORDER BY day DESC, created_at DESC LIMIT ?`).all(
      ...params,
      query.limit ?? 60,
    ) as unknown as ReportRow[];
    return rows.map(mapReport);
  }

  // -------------------------------------------------------------- settings
  getSetting(key: string): string | null {
    const row = this.stmt('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.stmt(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  allSettings(): Record<string, string> {
    const rows = this.stmt('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  // ---------------------------------------------------------------- tokens
  createToken(token: string, label: string, deviceId: string, at: number): void {
    this.stmt('INSERT INTO tokens (token, label, device_id, created_at, last_used_at, revoked) VALUES (?, ?, ?, ?, NULL, 0)').run(
      token,
      label,
      deviceId,
      at,
    );
  }

  getToken(token: string): { token: string; label: string; deviceId: string; revoked: boolean } | null {
    const row = this.stmt('SELECT * FROM tokens WHERE token = ?').get(token) as unknown as TokenRow | undefined;
    if (!row) return null;
    return { token: row.token, label: row.label, deviceId: row.device_id, revoked: row.revoked === 1 };
  }

  touchToken(token: string, at: number): void {
    this.stmt('UPDATE tokens SET last_used_at = ? WHERE token = ?').run(at, token);
  }

  listTokens(): { token: string; label: string; createdAt: number; lastUsedAt: number | null; revoked: boolean }[] {
    const rows = this.stmt('SELECT * FROM tokens ORDER BY created_at DESC').all() as unknown as TokenRow[];
    return rows.map((r) => ({
      token: r.token,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revoked: r.revoked === 1,
    }));
  }

  revokeToken(token: string): boolean {
    return Number(this.stmt('UPDATE tokens SET revoked = 1 WHERE token = ?').run(token).changes) > 0;
  }

  createPairing(code: string, at: number, expiresAt: number): void {
    this.stmt('INSERT INTO pairing (code, created_at, expires_at, used_at, device_name) VALUES (?, ?, ?, NULL, NULL)').run(
      code,
      at,
      expiresAt,
    );
  }

  consumePairing(code: string, at: number, deviceName: string): boolean {
    const row = this.stmt('SELECT * FROM pairing WHERE code = ?').get(code) as unknown as PairingRow | undefined;
    if (!row) return false;
    if (row.used_at !== null) return false;
    if (row.expires_at < at) return false;
    this.stmt('UPDATE pairing SET used_at = ?, device_name = ? WHERE code = ?').run(at, deviceName, code);
    return true;
  }

  exportAll(): Record<string, unknown[]> {
    return {
      devices: this.stmt('SELECT * FROM devices').all(),
      rollups: this.stmt('SELECT * FROM rollups').all(),
      segments: this.stmt('SELECT * FROM segments').all(),
      tasks: this.stmt('SELECT * FROM tasks').all(),
      journal: this.stmt('SELECT * FROM journal').all(),
      reports: this.stmt('SELECT * FROM reports').all(),
    };
  }
}

// ---------------------------------------------------------------- row types

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  hostname: string;
  created_at: number;
  last_seen_at: number;
  trusted: number;
}

interface RollupDbRow {
  device_id: string;
  minute: number;
  app: string;
  exe_path: string;
  category: string;
  context: string;
  foreground_ms: number;
  background_ms: number;
  away_ms: number;
  cpu_ms: number;
  peak_mem_bytes: number;
  switches: number;
}

interface SegmentRow {
  id: number;
  device_id: string;
  app: string;
  exe_path: string;
  context: string;
  detail: string;
  title: string;
  category: string;
  rule_id: string;
  start: number;
  end: number;
  idle_end: number;
}

interface TaskRow {
  id: number;
  device_id: string;
  title: string;
  notes: string;
  status: string;
  priority: string;
  due_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  source: string;
  tags: string;
  estimate_min: number | null;
  reminded_at: number | null;
}

interface JournalRow {
  id: number;
  device_id: string;
  start: number;
  end: number;
  text: string;
  source: string;
  tags: string;
  created_at: number;
  report_id: number | null;
}

interface ReportRow {
  id: number;
  device_id: string;
  day: string;
  kind: string;
  stats: string;
  narrative: string | null;
  model: string | null;
  created_at: number;
  redacted: number;
}

interface TokenRow {
  token: string;
  label: string;
  device_id: string;
  created_at: number;
  last_used_at: number | null;
  revoked: number;
}

interface PairingRow {
  code: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  device_name: string | null;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function mapDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as Platform,
    hostname: row.hostname,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    trusted: row.trusted === 1,
  };
}

function mapRollup(row: RollupDbRow): RollupRow {
  return {
    deviceId: row.device_id,
    minute: row.minute,
    app: row.app,
    exePath: row.exe_path,
    category: row.category,
    context: row.context,
    foregroundMs: row.foreground_ms,
    backgroundMs: row.background_ms,
    awayMs: row.away_ms,
    cpuMs: row.cpu_ms,
    peakMemBytes: row.peak_mem_bytes,
    switches: row.switches,
  };
}

function mapSegment(row: SegmentRow): ActivitySegment {
  return {
    id: row.id,
    deviceId: row.device_id,
    app: row.app,
    exePath: row.exe_path,
    context: row.context,
    detail: row.detail,
    title: row.title,
    category: row.category,
    ruleId: row.rule_id,
    start: row.start,
    end: row.end,
    idleEnd: row.idle_end === 1,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    deviceId: row.device_id,
    title: row.title,
    notes: row.notes,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    source: row.source,
    tags: parseJsonArray(row.tags),
    estimateMin: row.estimate_min,
    remindedAt: row.reminded_at,
  };
}

function mapJournal(row: JournalRow): JournalEntry {
  return {
    id: row.id,
    deviceId: row.device_id,
    start: row.start,
    end: row.end,
    text: row.text,
    source: row.source,
    tags: parseJsonArray(row.tags),
    createdAt: row.created_at,
    reportId: row.report_id,
  };
}

function mapReport(row: ReportRow): ReportRecord {
  let stats: ReportRecord['stats'];
  try {
    stats = JSON.parse(row.stats) as ReportRecord['stats'];
  } catch {
    stats = {} as ReportRecord['stats'];
  }
  return {
    id: row.id,
    deviceId: row.device_id,
    day: row.day,
    kind: row.kind as ReportKind,
    stats,
    ...(row.narrative ? { narrative: row.narrative } : {}),
    ...(row.model ? { model: row.model } : {}),
    createdAt: row.created_at,
    redacted: row.redacted === 1,
  };
}
