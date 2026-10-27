/**
 * The dashboard shell: data loading, routing, and the bottom tab bar.
 *
 * State lives here rather than in a store because there are only a handful of
 * resources and they all share one refresh trigger (the SSE stream). A store
 * would be more machinery than the problem has.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { humanDuration } from '@attentio/shared';
import type {
  BlocksResponse,
  DayResponse,
  HealthResponse,
  JournalEntry,
  LiveStatus,
  PublicSettings,
  ReportRecord,
  SseEvent,
  Task,
  TimelineResponse,
  TrendResponse,
} from '@attentio/shared';

import { api, ApiError, getToken, setToken, subscribe } from './api.ts';
import { JournalView, ReportsView, SettingsView, TasksView } from './capture.tsx';
import { Pet, type Skin } from './pet.tsx';
import { AppsView, FocusView, TimelineView, TodayView, toDayKey } from './views.tsx';
import { Card, ErrorNote, Spinner } from './ui.tsx';

type Tab = 'today' | 'timeline' | 'apps' | 'focus' | 'tasks' | 'journal' | 'reports' | 'settings';

const TABS: { id: Tab; label: string; labelZh: string; icon: string }[] = [
  { id: 'today', label: 'Today', labelZh: '今天', icon: '◎' },
  { id: 'timeline', label: 'Timeline', labelZh: '时间线', icon: '≡' },
  { id: 'apps', label: 'Apps', labelZh: '程序', icon: '▤' },
  { id: 'focus', label: 'Focus', labelZh: '专注', icon: '◈' },
  { id: 'tasks', label: 'Tasks', labelZh: '待办', icon: '☑' },
  { id: 'journal', label: 'Journal', labelZh: '日志', icon: '✎' },
  { id: 'reports', label: 'Reports', labelZh: '报告', icon: '❖' },
  { id: 'settings', label: 'Settings', labelZh: '设置', icon: '⚙' },
];

export function App() {
  const [tab, setTab] = useState<Tab>(() => (hashTab() ?? 'today') as Tab);
  const [day, setDay] = useState(() => toDayKey(new Date()));
  const [locale, setLocale] = useState<'en' | 'zh'>('en');
  const [appFilter, setAppFilter] = useState('');

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [dayData, setDayData] = useState<DayResponse | null>(null);
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [blocks, setBlocks] = useState<BlocksResponse | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [settings, setSettings] = useState<PublicSettings | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [connection, setConnection] = useState<'open' | 'closed'>('closed');
  const [token, setTokenState] = useState(() => getToken());
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  // ---- deep links: #/timeline, #/tasks, ... -------------------------------
  useEffect(() => {
    const onHash = () => {
      const next = hashTab();
      if (next) setTab(next as Tab);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const target = `#/${tab}`;
    if (window.location.hash !== target) window.history.replaceState(null, '', target);
  }, [tab]);

  // ---- initial + on-demand loading ---------------------------------------
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const healthResponse = await api.health();
        if (cancelled) return;
        setHealth(healthResponse);
        if (!healthResponse.aiEnabled) {
          // No AI configured — nothing to fetch beyond the basics.
        }
        const [dayResponse, settingsResponse] = await Promise.all([
          api.day({ day }),
          api.settings(),
        ]);
        if (cancelled) return;
        setDayData(dayResponse);
        setSettings(settingsResponse);
        setLocale(settingsResponse.ui.locale);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(caught as Error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [day, reloadKey, token]);

  // Secondary resources, fetched only for the tab that shows them.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (tab === 'today') {
          const response = await api.trend({ days: 14 });
          if (!cancelled) setTrend(response);
        } else if (tab === 'timeline') {
          const response = await api.timeline({ day });
          if (!cancelled) setTimeline(response);
        } else if (tab === 'focus') {
          const response = await api.blocks({ day });
          if (!cancelled) setBlocks(response);
        } else if (tab === 'tasks') {
          const response = await api.tasks({ status: 'all' });
          if (!cancelled) setTasks(response.tasks);
        } else if (tab === 'journal') {
          const response = await api.journal({ day });
          if (!cancelled) setJournal(response.entries);
        } else if (tab === 'reports') {
          const response = await api.reports();
          if (!cancelled) setReports(response.reports);
        }
      } catch (caught) {
        if (!cancelled) setError(caught as Error);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [tab, day, reloadKey]);

  // ---- live stream --------------------------------------------------------
  useEffect(() => {
    const stop = subscribe(
      (event: SseEvent) => {
        if (event.type === 'live') setLive(event.status);
        else if (event.type === 'day') reload();
        else if (event.type === 'reminder') {
          notify(event.message);
        }
      },
      setConnection,
    );
    return stop;
  }, [reload, token]);

  // Poll live status even without SSE: on a phone the stream can be killed by
  // the OS when the tab is backgrounded, and a stale "focused" badge is worse
  // than no badge.
  useEffect(() => {
    const interval = window.setInterval(() => {
      void api
        .day({ day })
        .then(setDayData)
        .catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [day]);

  // Theme and font are properties of the document, not of any one component,
  // so they are applied once here rather than threaded through the tree.
  useEffect(() => {
    const root = document.documentElement;
    const theme = settings?.ui.theme ?? 'system';
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);

    if (settings?.ui.fontFamily) root.style.setProperty('--font-family', settings.ui.fontFamily);
    else root.style.removeProperty('--font-family');
  }, [settings?.ui.theme, settings?.ui.fontFamily]);

  const setLocaleAndPersist = (next: 'en' | 'zh') => {
    setLocale(next);
    void api.updateSettings({ ui: { locale: next } }).catch(() => undefined);
  };

  const zh = locale === 'zh';
  const tabs = useMemo(() => TABS.map((tab_) => ({ ...tab_, text: zh ? tab_.labelZh : tab_.label })), [zh]);

  if (loading) {
    return (
      <div class="boot">
        <Spinner label={zh ? '正在连接本机服务…' : 'Connecting to the local daemon…'} />
      </div>
    );
  }

  return (
    <div class={`app scale-${Math.round((settings?.ui.fontScale ?? 1) * 100)}`}>
      <header class="topbar">
        <div class="brand">
          <span class="brand-dot" />
          <strong>Attentio</strong>
          {health && <span class="muted small">v{health.version}</span>}
        </div>
        <div class="live">
          {live?.current && !live.away ? (
            <span class="live-now">
              <span class="pulse" />
              {live.current.app}
              <span class="muted small">
                {' '}
                {humanDuration(Date.now() - live.current.since, { compact: true })}
              </span>
            </span>
          ) : (
            <span class="muted small">{live?.away ? (zh ? '离开' : 'away') : zh ? '待机' : 'idle'}</span>
          )}
        </div>
      </header>

      {error && (
        <div class="error-wrap">
          <ErrorNote error={error} onRetry={reload} />
          {error instanceof ApiError && error.status === 401 && (
            <PairPrompt
              locale={locale}
              onPaired={(issued) => {
                setToken(issued);
                setTokenState(issued);
                setError(null);
              }}
            />
          )}
        </div>
      )}

      <main>
        {tab === 'today' &&
          (dayData ? (
            <TodayView
              day={day}
              data={dayData}
              trend={trend}
              locale={locale}
              onDay={setDay}
              onOpenApp={(app) => {
                setAppFilter(app);
                setTab('apps');
              }}
            />
          ) : (
            <Spinner />
          ))}

        {tab === 'timeline' &&
          (timeline ? (
            <TimelineView
              day={day}
              segments={timeline.segments}
              truncated={timeline.truncated}
              locale={locale}
              onDay={setDay}
            />
          ) : (
            <Spinner />
          ))}

        {tab === 'apps' &&
          (dayData ? (
            <AppsView data={dayData} locale={locale} filter={appFilter} onFilter={setAppFilter} />
          ) : (
            <Spinner />
          ))}

        {tab === 'focus' &&
          (blocks ? (
            <FocusView
              day={day}
              blocks={blocks.blocks}
              minBlockMs={blocks.minBlockMs}
              locale={locale}
              onDay={setDay}
            />
          ) : (
            <Spinner />
          ))}

        {tab === 'tasks' && (
          <TasksView tasks={tasks} locale={locale} reload={reload} onError={setError} />
        )}

        {tab === 'journal' && (
          <JournalView
            entries={journal}
            day={day}
            locale={locale}
            reload={reload}
            onError={setError}
          />
        )}

        {tab === 'reports' && (
          <ReportsView
            reports={reports}
            day={day}
            locale={locale}
            aiEnabled={health?.aiEnabled ?? false}
            reload={reload}
            onError={setError}
          />
        )}

        {tab === 'settings' &&
          (settings ? (
            <SettingsView
              settings={settings}
              locale={locale}
              onLocale={setLocaleAndPersist}
              reload={reload}
              onError={setError}
              token={token}
              onToken={setToken}
              connection={connection}
              version={health?.version ?? '?'}
            />
          ) : (
            <Spinner />
          ))}

        {tab === 'settings' && !health && (
          <Card title="Daemon">
            <p class="muted small">No health response yet.</p>
          </Card>
        )}
      </main>

      {settings?.ui.petEnabled && (
        <Pet
          live={live}
          stats={dayData?.stats ?? null}
          locale={locale}
          skin={(settings.ui.petSkin as Skin) || 'sprout'}
          size={96}
          onOpenSettings={() => setTab('settings')}
        />
      )}

      <nav class="tabbar">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            class={tab === entry.id ? 'tab-button active' : 'tab-button'}
            onClick={() => setTab(entry.id)}
          >
            <span class="tab-icon" aria-hidden="true">
              {entry.icon}
            </span>
            <span class="tab-text">{entry.text}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function PairPrompt({ locale, onPaired }: { locale: 'en' | 'zh'; onPaired: (token: string) => void }) {
  const zh = locale === 'zh';
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await api.pair({
        code: code.trim(),
        deviceName: `${navigator.platform || 'web'} browser`,
        platform: 'web',
      });
      onPaired(response.token);
    } catch (caught) {
      setFailure((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={zh ? '配对此设备' : 'Pair this device'}>
      <p class="muted small">
        {zh
          ? '在运行 Attentio 的电脑上执行 `attentio pair`，把显示的六位码填在下面。'
          : 'Run `attentio pair` on the machine running Attentio, then enter the six-digit code below.'}
      </p>
      <div class="quick-add">
        <input
          type="text"
          inputMode="numeric"
          value={code}
          placeholder={zh ? '六位配对码' : 'six-digit code'}
          onInput={(event) => setCode((event.currentTarget as HTMLInputElement).value)}
        />
        <button type="button" disabled={busy || !code.trim()} onClick={() => void submit()}>
          {busy ? '…' : zh ? '配对' : 'Pair'}
        </button>
      </div>
      {failure && <p class="overdue small">{failure}</p>}
    </Card>
  );
}

function hashTab(): string | null {
  const match = /^#\/([a-z]+)$/.exec(window.location.hash);
  return match?.[1] ?? null;
}

/** Reminders are announced through the browser when the tab is hidden. */
function notify(message: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification('Attentio', { body: message });
  }
}

export function useNotificationPermission(): () => void {
  const asked = useRef(false);
  return useCallback(() => {
    if (asked.current || typeof Notification === 'undefined') return;
    asked.current = true;
    void Notification.requestPermission();
  }, []);
}
