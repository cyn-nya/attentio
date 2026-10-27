/**
 * Typed client for the local daemon.
 *
 * The token lives in `localStorage` and is only ever sent to the origin that
 * issued it. On loopback the daemon does not ask for one, so the common case —
 * opening the dashboard on the machine being tracked — needs no setup at all.
 */

import { API_PREFIX, SSE_PATH } from '@attentio/shared';
import type {
  BlocksResponse,
  CreateJournalRequest,
  CreateTaskRequest,
  DayResponse,
  DevicesResponse,
  HealthResponse,
  JournalResponse,
  PublicSettings,
  ReportsResponse,
  SseEvent,
  Task,
  TasksResponse,
  TimelineResponse,
  TrendResponse,
  UpdateTaskRequest,
} from '@attentio/shared';

const TOKEN_KEY = 'attentio.token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode — the dashboard still works on loopback */
  }
}

export class ApiError extends Error {
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);

  const response = await fetch(`${API_PREFIX}${path}`, { ...init, headers });
  const text = await response.text();
  const body: unknown = text ? safeParse(text) : null;

  if (!response.ok) {
    const shape = body as { error?: { code?: string; message?: string; hint?: string } } | null;
    throw new ApiError(
      response.status,
      shape?.error?.code ?? 'http_error',
      shape?.error?.message ?? `${response.status} ${response.statusText}`,
      shape?.error?.hint,
    );
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface DayParams {
  day?: string;
  deviceId?: string;
  focusPreset?: string;
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  day: (params: DayParams = {}) => request<DayResponse>(`/day${query({ ...params })}`),

  timeline: (params: { day?: string; deviceId?: string; limit?: number } = {}) =>
    request<TimelineResponse>(`/timeline${query({ ...params })}`),

  trend: (params: { end?: string; days?: number; deviceId?: string } = {}) =>
    request<TrendResponse>(`/trend${query({ ...params })}`),

  blocks: (params: { day?: string; deviceId?: string } = {}) =>
    request<BlocksResponse>(`/blocks${query({ ...params })}`),

  devices: () => request<DevicesResponse>('/devices'),

  tasks: (params: { status?: string; tag?: string } = {}) =>
    request<TasksResponse>(`/tasks${query({ ...params })}`),

  createTask: (body: CreateTaskRequest) =>
    request<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),

  updateTask: (id: number, body: UpdateTaskRequest) =>
    request<{ task: Task }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteTask: (id: number) => request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' }),

  journal: (params: { day?: string; from?: number; to?: number } = {}) =>
    request<JournalResponse>(`/journal${query({ ...params })}`),

  createJournal: (body: CreateJournalRequest) =>
    request<{ entry: JournalResponse['entries'][number] }>('/journal', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteJournal: (id: number) => request<{ ok: boolean }>(`/journal/${id}`, { method: 'DELETE' }),

  reports: () => request<ReportsResponse>('/reports'),

  generateReport: (body: { day?: string; kind?: string; statsOnly?: boolean; instruction?: string }) =>
    request<ReportsResponse['reports'][number]>('/reports/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  settings: () => request<PublicSettings>('/settings'),

  updateSettings: (body: unknown) =>
    request<PublicSettings>('/settings', { method: 'PATCH', body: JSON.stringify(body) }),

  pair: (body: { code: string; deviceName: string; platform: string }) =>
    request<{ token: string; device: { id: string; name: string } }>('/pair', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

/**
 * Subscribe to the daemon's event stream.
 *
 * `EventSource` cannot set headers, so the token rides in the query string. That
 * is acceptable here for the same reason the whole API is: it never leaves the
 * local network, and the alternative (a WebSocket) costs more than it buys.
 */
export function subscribe(
  onEvent: (event: SseEvent) => void,
  onStateChange?: (state: 'open' | 'closed') => void,
): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retry = 0;
  let timer: number | undefined;

  const connect = (): void => {
    if (closed) return;
    const token = getToken();
    const url = `${SSE_PATH}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    source = new EventSource(url, { withCredentials: false });

    source.onopen = () => {
      retry = 0;
      onStateChange?.('open');
    };
    source.onmessage = (message) => {
      const parsed = safeParse(message.data);
      if (parsed) onEvent(parsed as SseEvent);
    };
    // Named events arrive as `event: live` frames, which EventSource routes to a
    // listener per name rather than to onmessage.
    for (const name of ['hello', 'live', 'day', 'task', 'report', 'reminder']) {
      source.addEventListener(name, (message) => {
        const parsed = safeParse((message as MessageEvent<string>).data);
        if (parsed) onEvent(parsed as SseEvent);
      });
    }
    source.onerror = () => {
      source?.close();
      source = null;
      onStateChange?.('closed');
      if (closed) return;
      // Back off so a phone that lost Wi-Fi is not hammering the daemon.
      retry = Math.min(retry + 1, 6);
      timer = window.setTimeout(connect, Math.min(1000 * 2 ** retry, 30_000));
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    source?.close();
  };
}
