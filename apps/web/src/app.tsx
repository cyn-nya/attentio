/**
 * The dashboard shell: data loading, routing, and the bottom tab bar.
 *
 * State lives here rather than in a store because there are only a handful of
 * resources and they all share one refresh trigger (the SSE stream). A store
 * would be more machinery than the problem has.
 */

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';

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
import { Card, ErrorNote, ReminderStack, Spinner, type Reminder } from './ui.tsx';

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
  // Empty until settings arrive: the boundary that decides which day is "today"
  // comes from the daemon, and guessing it here would file a late-night session
  // under the wrong date.
  const [day, setDay] = useState('');
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

  // Reminders that have arrived and not been dismissed. Kept in memory rather
  // than storage: a reminder is about *now*, and one that reappears after a reload
  // an hour later is a bug the user cannot get rid of.
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const showReminder = useCallback((reminder: Reminder) => {
    setReminders((current) =>
      // The daemon may retry, and SSE reconnects replay nothing, but a duplicate
      // that slips through must not stack up visually.
      current.some((existing) => existing.id === reminder.id) ? current : [...current, reminder],
    );
  }, []);
  const dismissReminder = useCallback((id: string) => {
    setReminders((current) => current.filter((reminder) => reminder.id !== id));
  }, []);
  const completeReminder = useCallback(
    (taskId: number) => {
      setReminders((current) => current.filter((reminder) => reminder.taskId !== taskId));
      void api
        .updateTask(taskId, { status: 'done' })
        .then(() => {
          setReloadKey((key) => key + 1);
        })
        .catch(() => undefined);
    },
    [],
  );

  // ---- live stream --------------------------------------------------------
  useEffect(() => {
    const stop = subscribe(
      (event: SseEvent) => {
        switch (event.type) {
          case 'live':
            setLive(event.status);
            break;

          case 'day':
            reload();
            break;

          case 'task':
            // A task can be created from the CLI, from a phone, or by the parser
            // running somewhere else. Without this the list on screen silently
            // disagrees with the database, which is worse than a visible reload.
            setReloadKey((key) => key + 1);
            // Completing a task elsewhere should clear its reminder here too.
            if (event.action === 'completed' || event.action === 'deleted') {
              setReminders((current) =>
                current.filter((reminder) => reminder.taskId !== event.task.id),
              );
            }
            break;

          case 'report':
            // The automatic daily report arrives with no user action, so this is
            // the only way the reports tab learns about it.
            setReloadKey((key) => key + 1);
            break;

          case 'reminder':
            // Both paths, deliberately. The in-page stack is the one that is
            // guaranteed to be seen; the OS notification is what reaches the user
            // when this tab is in the background, which is the common case for a
            // reminder.
            showReminder({
              id: `${event.task.id}-${event.at}`,
              message: event.message,
              taskId: event.task.id,
              ...(event.task.dueAt != null ? { dueAt: event.task.dueAt } : {}),
            });
            notify('Attentio', event.message);
            break;
        }
      },
      setConnection,
    );
    return stop;
  }, [reload, token, showReminder]);

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

  const notification = useNotificationPermission();

  // Keep the selected day honest. Until settings load there is no day; once they
  // do, "today" means whatever the daemon's boundary says it means. A user who
  // picked a day explicitly keeps it.
  const dayStartHour = settings?.tracking.dayStartHour ?? 0;
  useEffect(() => {
    setDay((current) => (current === '' ? toDayKey(new Date(), dayStartHour) : current));
  }, [dayStartHour]);

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

      <ReminderStack
        reminders={reminders}
        onDismiss={dismissReminder}
        onComplete={completeReminder}
      />

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
              notifications={notification.state}
              onRequestNotifications={() => void notification.request()}
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

/**
 * Send a reminder to the operating system, if it will take one.
 *
 * Best-effort by design: every failure mode here (no API, permission denied,
 * permission never asked, an insecure origin) is normal, and none of them should
 * affect whether the user is told. That is `ReminderStack`'s job.
 *
 * The tab being visible is part of the decision: showing an OS notification for
 * something already on screen is noise, and some browsers suppress it anyway.
 */
function notify(title: string, body: string): boolean {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return false;
  try {
    new Notification(title, { body, tag: 'attentio-reminder' });
    return true;
  } catch {
    // Some platforms throw on construction rather than resolving a permission.
    return false;
  }
}

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

/**
 * Notification permission, requested only when the user asks for it.
 *
 * Asking on load is the pattern that trains people to click "block": the request
 * arrives with no context, from a page they have not decided to trust yet. Here
 * the button that triggers it says what it is for and what happens if you say no
 * (reminders stay in the page).
 */
export function useNotificationPermission(): {
  state: NotificationState;
  request: () => Promise<NotificationState>;
} {
  const [state, setState] = useState<NotificationState>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  const request = useCallback(async (): Promise<NotificationState> => {
    if (typeof Notification === 'undefined') return 'unsupported';
    try {
      const result = await Notification.requestPermission();
      setState(result);
      return result;
    } catch {
      // Safari < 16 returns undefined from requestPermission rather than a string.
      const current = Notification.permission;
      setState(current);
      return current;
    }
  }, []);

  return { state, request };
}
