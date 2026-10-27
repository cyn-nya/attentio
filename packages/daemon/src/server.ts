/**
 * HTTP server: the API, the SSE feed, and the web dashboard.
 *
 * Built on `node:http` with a hand-rolled router. That is a deliberate choice
 * rather than a missing dependency: Attentio ships as a single `npm install`
 * with no build step for the daemon, and the routing needs here are genuinely
 * small. The one place a framework would help — a growing pile of middleware —
 * is exactly what this design avoids by keeping auth and JSON handling explicit.
 *
 * Access model:
 *   - loopback requests are trusted unless `requireAuth` is set;
 *   - anything else must present a pairing token, and is refused outright when
 *     remote access is disabled. There is no "just expose it and hope".
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';

import { API_PREFIX, SSE_PATH, dayKey, sseFrame } from '@attentio/shared';
import type {
  ApiErrorBody,
  CollectorStatus,
  CreateJournalRequest,
  CreateTaskRequest,
  DayQuery,
  GenerateReportRequest,
  HealthResponse,
  JournalQuery,
  LiveStatus,
  PairRequest,
  PairResponse,
  Platform,
  PublicSettings,
  SseEvent,
  TaskStatus,
  TasksQuery,
  TimelineQuery,
  TrendResponse,
  UpdateTaskRequest,
} from '@attentio/shared';

import {
  computeBlocks,
  computeDay,
  computeTimeline,
  computeTrend,
  type TrendQuery,
} from './analytics.ts';
import { toPublicSettings, type AttentioConfig } from './config.ts';
import type { Db } from './db/index.ts';
import type { Engine } from './engine.ts';

export const VERSION = '0.1.0';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface ServerOptions {
  config: AttentioConfig;
  db: Db;
  engine: Engine;
  /** Directory holding the built PWA. Missing is fine — the API still works. */
  webRoot?: string;
  /** Overrides the configured port; 0 asks the OS for a free one (tests). */
  port?: number;
  host?: string;
}

export interface AttentioServer {
  server: Server;
  port: number;
  url: string;
  /** LAN URLs a phone on the same network can use. */
  lanUrls: string[];
  close: () => Promise<void>;
  /** Used by the CLI to show a pairing code. */
  createPairingCode: (ttlMs?: number) => { code: string; expiresAt: number };
  /** Push an event to every connected client (task reminders use this). */
  notify: (event: SseEvent) => void;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

export async function createAttentioServer(options: ServerOptions): Promise<AttentioServer> {
  const { config, db, engine } = options;
  const startedAt = Date.now();
  const sseClients = new Set<ServerResponse>();
  const webRoot = options.webRoot ? resolve(options.webRoot) : undefined;

  // ---------------------------------------------------------------- helpers
  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  };

  const sendError = (res: ServerResponse, error: unknown): void => {
    if (error instanceof HttpError) {
      const body: ApiErrorBody = {
        error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) },
      };
      sendJson(res, error.status, body);
      return;
    }
    const message = error instanceof Error ? error.message : 'unexpected error';
    sendJson(res, 500, { error: { code: 'internal', message } } satisfies ApiErrorBody);
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      // A local API has no legitimate reason to receive megabytes.
      if (size > 2 * 1024 * 1024) throw new HttpError(413, 'payload_too_large', 'Request body exceeds 2 MB');
      chunks.push(buf);
    }
    if (size === 0) return {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpError(400, 'bad_json', 'Request body must be a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'bad_json', 'Request body is not valid JSON');
    }
  };

  const isLoopback = (req: IncomingMessage): boolean => {
    const address = req.socket.remoteAddress ?? '';
    return (
      address === '127.0.0.1' ||
      address === '::1' ||
      address === '::ffff:127.0.0.1' ||
      address.startsWith('127.')
    );
  };

  const tokenFrom = (req: IncomingMessage, url: URL): string => {
    const header = req.headers.authorization ?? '';
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    return url.searchParams.get('token') ?? '';
  };

  const authorize = (req: IncomingMessage, url: URL): void => {
    const loopback = isLoopback(req);
    if (loopback && !config.remote.requireAuth) return;
    if (!config.remote.enabled) {
      throw new HttpError(
        403,
        'remote_disabled',
        'Remote access is disabled.',
        'Enable it in Settings (or set ATTENTIO_REMOTE=1) to use Attentio from another device.',
      );
    }
    const token = tokenFrom(req, url);
    if (!token) {
      throw new HttpError(401, 'unauthenticated', 'A pairing token is required.', 'Pair this device in Settings.');
    }
    const record = db.getToken(token);
    if (!record || record.revoked) {
      throw new HttpError(401, 'bad_token', 'This pairing token is not valid any more.', 'Pair this device again.');
    }
    db.touchToken(token, Date.now());
  };

  // ------------------------------------------------------------------ routes
  const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // Pairing is the one endpoint that must work before a token exists, so it
    // is handled before authorization and guarded by a one-time code instead.
    if (path === `${API_PREFIX}/pair` && method === 'POST') {
      const body = (await readBody(req)) as unknown as PairRequest;
      const code = String(body.code ?? '').trim();
      if (!code) throw new HttpError(400, 'missing_code', 'A pairing code is required.');
      if (!db.consumePairing(code, Date.now(), String(body.deviceName ?? 'unknown device'))) {
        throw new HttpError(403, 'bad_pairing_code', 'That pairing code is wrong, already used, or expired.');
      }
      const token = randomBytes(32).toString('base64url');
      db.createToken(token, String(body.deviceName ?? 'unknown device'), config.deviceId, Date.now());
      db.upsertDevice({
        id: config.deviceId,
        name: config.deviceName,
        platform: toPlatform(),
        hostname: '',
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        trusted: true,
      });
      const device = db.getDevice(config.deviceId);
      const response: PairResponse = {
        token,
        device: device ?? {
          id: config.deviceId,
          name: config.deviceName,
          platform: 'unknown',
          hostname: '',
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          trusted: true,
        },
        apiBase: '/api',
      };
      sendJson(res, 200, response);
      return;
    }

    if (path === `${API_PREFIX}/health`) {
      const response: HealthResponse = {
        ok: true,
        version: VERSION,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        aiEnabled: config.ai.enabled && config.ai.apiKey.length > 0,
        collectors: engine.collectorStatus(),
      };
      sendJson(res, 200, response);
      return;
    }

    authorize(req, url);

    if (path === `${API_PREFIX}/live`) {
      sendJson(res, 200, engine.status() satisfies LiveStatus);
      return;
    }

    if (path === `${API_PREFIX}/devices`) {
      sendJson(res, 200, { devices: db.listDevices() });
      return;
    }

    if (path === `${API_PREFIX}/day`) {
      const query: DayQuery = {
        ...(url.searchParams.get('day') ? { day: url.searchParams.get('day') as string } : {}),
        ...(url.searchParams.get('deviceId') ? { deviceId: url.searchParams.get('deviceId') as string } : {}),
      };
      const preset = url.searchParams.get('focusPreset');
      if (preset === 'balanced' || preset === 'deep' || preset === 'calm') query.focusPreset = preset;
      sendJson(res, 200, computeDay({ db, config }, query));
      return;
    }

    if (path === `${API_PREFIX}/timeline`) {
      const query: TimelineQuery = {};
      const day = url.searchParams.get('day');
      const deviceId = url.searchParams.get('deviceId');
      const limit = url.searchParams.get('limit');
      if (day) query.day = day;
      if (deviceId) query.deviceId = deviceId;
      if (limit) query.limit = Number(limit) || undefined;
      sendJson(res, 200, computeTimeline({ db, config }, query));
      return;
    }

    if (path === `${API_PREFIX}/trend`) {
      const query: TrendQuery = {};
      const end = url.searchParams.get('end');
      const days = url.searchParams.get('days');
      const deviceId = url.searchParams.get('deviceId');
      if (end) query.end = end;
      if (days) query.days = Number(days);
      if (deviceId) query.deviceId = deviceId;
      if (url.searchParams.get('apps') === '1') query.apps = true;
      sendJson(res, 200, computeTrend({ db, config }, query) satisfies TrendResponse);
      return;
    }

    if (path === `${API_PREFIX}/blocks`) {
      const day = url.searchParams.get('day');
      const deviceId = url.searchParams.get('deviceId');
      sendJson(res, 200, computeBlocks({ db, config }, {
        ...(day ? { day } : {}),
        ...(deviceId ? { deviceId } : {}),
        minBlockMs: config.focus.minBlockMin * 60_000,
      }));
      return;
    }

    if (path === `${API_PREFIX}/reports` && method === 'GET') {
      sendJson(res, 200, { reports: db.listReports({ limit: 90 }) });
      return;
    }

    if (path === `${API_PREFIX}/reports/generate` && method === 'POST') {
      const body = (await readBody(req)) as unknown as GenerateReportRequest;
      // The report generator is injected by the CLI so that this module stays
      // free of LLM concerns; without one, stats-only is the honest answer.
      const generator = reportGenerator;
      if (!generator) {
        throw new HttpError(
          501,
          'no_generator',
          'Report generation is not wired up in this process.',
          'Run the daemon through the `attentio` CLI to enable reports.',
        );
      }
      sendJson(res, 200, await generator(body));
      return;
    }

    if (path === `${API_PREFIX}/tasks`) {
      if (method === 'GET') {
        const query: TasksQuery = {};
        const status = url.searchParams.get('status');
        if (status) query.status = status as TaskStatus | 'all';
        const dueBefore = url.searchParams.get('dueBefore');
        if (dueBefore) query.dueBefore = Number(dueBefore);
        const tag = url.searchParams.get('tag');
        if (tag) query.tag = tag;
        sendJson(res, 200, { tasks: db.listTasks(query) });
        return;
      }
      if (method === 'POST') {
        const body = (await readBody(req)) as unknown as CreateTaskRequest;
        const title = String(body.title ?? '').trim();
        if (!title) throw new HttpError(400, 'missing_title', 'A task needs a title.');
        const now = Date.now();
        const task = db.createTask({
          deviceId: config.deviceId,
          title,
          notes: String(body.notes ?? ''),
          status: 'open',
          priority: body.priority ?? 'normal',
          dueAt: parseTime(body.dueAt),
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          source: body.source ?? 'user',
          tags: body.tags ?? [],
          estimateMin: body.estimateMin ?? null,
          remindedAt: null,
        });
        broadcast({ type: 'task', at: Date.now(), action: 'created', task });
        sendJson(res, 201, { task });
        return;
      }
    }

    const taskMatch = new RegExp(`^${API_PREFIX}/tasks/(\\d+)$`).exec(path);
    if (taskMatch) {
      const id = Number(taskMatch[1]);
      if (method === 'PATCH' || method === 'PUT') {
        const body = (await readBody(req)) as unknown as UpdateTaskRequest;
        const patch: Record<string, unknown> = {};
        if (body.title !== undefined) patch['title'] = String(body.title);
        if (body.notes !== undefined) patch['notes'] = String(body.notes);
        if (body.priority !== undefined) patch['priority'] = body.priority;
        if (body.tags !== undefined) patch['tags'] = body.tags;
        if (body.estimateMin !== undefined) patch['estimateMin'] = body.estimateMin;
        if (body.dueAt !== undefined) patch['dueAt'] = parseTime(body.dueAt);
        if (body.status !== undefined) {
          patch['status'] = body.status;
          patch['completedAt'] = body.status === 'done' ? Date.now() : null;
        }
        const task = db.updateTask(id, patch);
        if (!task) throw new HttpError(404, 'not_found', `No task with id ${id}`);
        broadcast({ type: 'task', at: Date.now(), action: 'updated', task });
        sendJson(res, 200, { task });
        return;
      }
      if (method === 'DELETE') {
        if (!db.deleteTask(id)) throw new HttpError(404, 'not_found', `No task with id ${id}`);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (path === `${API_PREFIX}/journal`) {
      if (method === 'GET') {
        const query: JournalQuery = {};
        const day = url.searchParams.get('day');
        if (day) {
          const anchor = Date.parse(`${day}T00:00:00`);
          if (Number.isFinite(anchor)) {
            query.from = anchor;
            query.to = anchor + 86_400_000;
          }
        }
        const from = url.searchParams.get('from');
        if (from) query.from = Number(from);
        const to = url.searchParams.get('to');
        if (to) query.to = Number(to);
        sendJson(res, 200, { entries: db.listJournal(query) });
        return;
      }
      if (method === 'POST') {
        const body = (await readBody(req)) as unknown as CreateJournalRequest;
        const text = String(body.text ?? '').trim();
        if (!text) throw new HttpError(400, 'missing_text', 'A journal entry needs some text.');
        const now = Date.now();
        const entry = db.createJournal({
          deviceId: config.deviceId,
          text,
          start: parseTime(body.start) ?? now - 30 * 60_000,
          end: parseTime(body.end) ?? now,
          tags: body.tags ?? [],
          source: body.source ?? 'user',
          createdAt: now,
          reportId: null,
        });
        sendJson(res, 201, { entry });
        return;
      }
    }

    const journalMatch = new RegExp(`^${API_PREFIX}/journal/(\\d+)$`).exec(path);
    if (journalMatch && method === 'DELETE') {
      if (!db.deleteJournal(Number(journalMatch[1]))) {
        throw new HttpError(404, 'not_found', 'No such journal entry');
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === `${API_PREFIX}/settings`) {
      if (method === 'GET') {
        sendJson(res, 200, toPublicSettings(config) satisfies PublicSettings);
        return;
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        applySettingsPatch(config, body);
        db.setSetting('ui', JSON.stringify(toPublicSettings(config).ui));
        sendJson(res, 200, toPublicSettings(config));
        return;
      }
    }

    if (path === `${API_PREFIX}/diagnostics`) {
      sendJson(res, 200, {
        version: VERSION,
        config: {
          deviceId: config.deviceId,
          deviceName: config.deviceName,
          platform: process.platform,
          node: process.version,
        },
        engine: engine.diagnostics(),
      });
      return;
    }

    throw new HttpError(404, 'not_found', `No route for ${method} ${path}`);
  };

  // -------------------------------------------------------------------- SSE
  const broadcast = (event: SseEvent): void => {
    if (sseClients.size === 0) return;
    const frame = sseFrame(event);
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const handleSse = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    authorize(req, url);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies (and phone browsers on some networks) buffer without this.
      'x-accel-buffering': 'no',
    });
    res.write(sseFrame({ type: 'hello', at: Date.now(), deviceId: config.deviceId, version: VERSION }));
    res.write(sseFrame({ type: 'live', at: Date.now(), status: engine.status() }));
    sseClients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 20_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  };

  // -------------------------------------------------------------- static web
  const serveStatic = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    if (!webRoot || !existsSync(webRoot)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Attentio web dashboard is not built. Run `npm run web:build`.');
      return;
    }
    const requested = decodeURIComponent(url.pathname);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    // Path traversal guard: the resolved path must stay inside webRoot.
    const candidate = resolve(join(webRoot, normalize(relative)));
    const inside = candidate === webRoot || candidate.startsWith(webRoot + sep);
    const target = inside && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(webRoot, 'index.html');
    if (!existsSync(target)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      // Hashed asset names are safe to cache; index.html never is.
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    createReadStream(target).pipe(res);
  };

  // ------------------------------------------------------------------ server
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    void (async () => {
      try {
        if (url.pathname === SSE_PATH) {
          handleSse(req, res, url);
          return;
        }
        if (url.pathname.startsWith(API_PREFIX)) {
          await route(req, res, url);
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed here`);
        }
        serveStatic(req, res, url);
      } catch (error) {
        if (!res.headersSent) sendError(res, error);
        else res.end();
      }
    })();
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const host = options.host ?? config.remote.bindHost;
  const port = options.port ?? config.remote.port;

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  // The dashboard is most often opened on this machine, so the primary URL is
  // loopback. On a wildcard bind the usable LAN addresses are reported separately
  // — picking "the first network interface" is how you end up advertising a VPN
  // or public address as if it were reachable from the phone.
  const url = `http://localhost:${boundPort}`;

  const lanUrls = listLanUrls(boundPort);

  // Live updates to every connected client.
  engine.on('live', () => broadcast({ type: 'live', at: Date.now(), status: engine.status() }));
  engine.on('day', () => broadcast({ type: 'day', at: Date.now(), day: dayKey(Date.now()) }));

  return {
    server,
    port: boundPort,
    url,
    lanUrls,
    close: () =>
      new Promise<void>((resolvePromise) => {
        for (const client of sseClients) {
          try {
            client.end();
          } catch {
            /* already gone */
          }
        }
        sseClients.clear();
        server.close(() => resolvePromise());
      }),
    notify: (event: SseEvent) => broadcast(event),
    createPairingCode: (ttlMs = 5 * 60_000) => {
      const code = String(randomInt(100_000, 999_999));
      const expiresAt = Date.now() + ttlMs;
      db.createPairing(code, Date.now(), expiresAt);
      return { code, expiresAt };
    },
  };

}

/**
 * True for addresses a phone on the same network can plausibly reach. VPN and
 * public addresses are excluded from the "open this on your phone" hint.
 */
export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Carrier-grade NAT and common hotspot ranges.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** Optional hook installed by the CLI so reports can use an LLM. */
export type ReportGenerator = (request: GenerateReportRequest) => Promise<unknown>;
let reportGenerator: ReportGenerator | null = null;

export function setReportGenerator(generator: ReportGenerator | null): void {
  reportGenerator = generator;
}

function listLanUrls(port: number): string[] {
  const private_: string[] = [];
  const other: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const url = `http://${entry.address}:${port}`;
      if (isPrivateIPv4(entry.address)) private_.push(url);
      else other.push(url);
    }
  }
  return [...private_, ...other];
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Accepts epoch ms, an ISO string, or a plain `YYYY-MM-DD`. */
function parseTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;
  const dateOnly = Date.parse(`${text}T00:00:00`);
  return Number.isFinite(dateOnly) ? dateOnly : null;
}

/** Only the fields a remote client is allowed to change. */
function applySettingsPatch(config: AttentioConfig, body: Record<string, unknown>): void {
  const ui = body['ui'];
  if (ui && typeof ui === 'object') {
    const patch = ui as Record<string, unknown>;
    if (patch['theme'] === 'system' || patch['theme'] === 'light' || patch['theme'] === 'dark') {
      config.ui.theme = patch['theme'];
    }
    if (patch['locale'] === 'en' || patch['locale'] === 'zh') config.ui.locale = patch['locale'];
    if (typeof patch['petEnabled'] === 'boolean') config.ui.petEnabled = patch['petEnabled'];
    if (typeof patch['petSkin'] === 'string') config.ui.petSkin = patch['petSkin'];
    if (typeof patch['fontScale'] === 'number') {
      config.ui.fontScale = Math.min(2, Math.max(0.75, patch['fontScale']));
    }
    if (typeof patch['fontFamily'] === 'string') config.ui.fontFamily = patch['fontFamily'].slice(0, 120);
  }
  const tracking = body['tracking'];
  if (tracking && typeof tracking === 'object') {
    const patch = tracking as Record<string, unknown>;
    if (typeof patch['captureTitles'] === 'boolean') config.tracking.captureTitles = patch['captureTitles'];
    if (Array.isArray(patch['excludeApps'])) {
      config.tracking.excludeApps = patch['excludeApps'].filter((v): v is string => typeof v === 'string');
    }
    if (Array.isArray(patch['excludeTitlePatterns'])) {
      config.tracking.excludeTitlePatterns = patch['excludeTitlePatterns'].filter(
        (v): v is string => typeof v === 'string',
      );
    }
  }
  const focus = body['focus'];
  if (focus && typeof focus === 'object') {
    const patch = focus as Record<string, unknown>;
    const preset = patch['preset'];
    if (preset === 'balanced' || preset === 'deep' || preset === 'calm' || preset === 'custom') {
      config.focus.preset = preset;
    }
    if (patch['weights'] && typeof patch['weights'] === 'object') {
      const weights = patch['weights'] as Record<string, unknown>;
      for (const key of Object.keys(config.focus.weights) as (keyof typeof config.focus.weights)[]) {
        const value = weights[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
          config.focus.weights[key] = value;
        }
      }
    }
  }
}

/** Node's platform string narrowed to Attentio's closed set. */
export function toPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'win32';
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'android':
      return 'android';
    default:
      return 'unknown';
  }
}

export function collectorSummary(statuses: readonly CollectorStatus[]): string {
  return statuses.map((s) => `${s.id} (${s.platform}): ${s.health} — ${s.detail}`).join('\n');
}
