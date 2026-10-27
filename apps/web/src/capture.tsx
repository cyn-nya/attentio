/**
 * Capture views: Tasks, Journal, Reports, Settings.
 *
 * These are the screens where the user *puts something in*, which is what makes
 * the rest of the app more than a log. Quick-add parses natural language
 * ("finish the report tomorrow 6pm !high #attentio") and shows what it understood
 * before saving, so a misparse is visible rather than silent.
 */

import { useState } from 'preact/hooks';

import { clockTime, describeParsedTask, parseTaskInput } from '@attentio/shared';
import type {
  JournalEntry,
  PublicSettings,
  ReportPreviewResponse,
  ReportRecord,
  Task,
} from '@attentio/shared';

import { api } from './api.ts';
import { Card, Empty, ErrorNote, Spinner } from './ui.tsx';

type Locale = 'en' | 'zh';

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function TasksView({
  tasks,
  locale,
  reload,
  onError,
}: {
  tasks: Task[];
  locale: Locale;
  reload: () => void;
  onError: (error: Error) => void;
}) {
  const zh = locale === 'zh';
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const parsed = draft.trim() ? parseTaskInput(draft) : null;
  const preview = parsed ? describeParsedTask(parsed, locale) : '';

  const submit = async () => {
    if (!parsed || busy) return;
    setBusy(true);
    try {
      await api.createTask({
        title: parsed.title,
        priority: parsed.priority,
        ...(parsed.dueAt ? { dueAt: parsed.dueAt } : {}),
        ...(parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
        ...(parsed.estimateMin ? { estimateMin: parsed.estimateMin } : {}),
      });
      setDraft('');
      reload();
    } catch (error) {
      onError(error as Error);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (task: Task) => {
    try {
      await api.updateTask(task.id, { status: task.status === 'done' ? 'open' : 'done' });
      reload();
    } catch (error) {
      onError(error as Error);
    }
  };

  const remove = async (task: Task) => {
    try {
      await api.deleteTask(task.id);
      reload();
    } catch (error) {
      onError(error as Error);
    }
  };

  const now = Date.now();
  const visible = tasks
    .filter((task) => showDone || task.status !== 'done')
    .sort((a, b) => {
      if (a.status === 'done' !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
      if (a.dueAt && b.dueAt) return a.dueAt - b.dueAt;
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return b.createdAt - a.createdAt;
    });
  const overdue = visible.filter((task) => task.status !== 'done' && task.dueAt !== null && task.dueAt < now);

  return (
    <Card title={zh ? '待办' : 'Tasks'}>
      <div class="quick-add">
        <input
          type="text"
          value={draft}
          placeholder={zh ? '要做什么？例如：明天 18:00 前写报告 !high #写作' : 'What next? e.g. write the report tomorrow 6pm !high #writing'}
          onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
        <button type="button" disabled={!parsed || busy} onClick={() => void submit()}>
          {zh ? '添加' : 'Add'}
        </button>
      </div>
      {preview && (
        <p class="muted small">
          {zh ? '识别为' : 'understood'}: <strong>{parsed?.title}</strong>
          {preview ? ` · ${preview}` : ''}
        </p>
      )}

      <label class="toggle">
        <input
          type="checkbox"
          checked={showDone}
          onChange={(event) => setShowDone((event.currentTarget as HTMLInputElement).checked)}
        />
        {zh ? '显示已完成' : 'Show completed'}
      </label>

      {overdue.length > 0 && (
        <p class="muted small">
          {zh ? `${overdue.length} 项已逾期。` : `${overdue.length} overdue.`}
        </p>
      )}

      {visible.length === 0 ? (
        <Empty>{zh ? '还没有待办。' : 'No tasks yet.'}</Empty>
      ) : (
        <ul class="task-list">
          {visible.map((task) => {
            const late = task.status !== 'done' && task.dueAt !== null && task.dueAt < now;
            return (
              <li key={task.id} class={task.status === 'done' ? 'task done' : 'task'}>
                <button
                  type="button"
                  class="task-check"
                  aria-label={task.status === 'done' ? 'Reopen' : 'Complete'}
                  onClick={() => void toggle(task)}
                >
                  {task.status === 'done' ? '✔' : '○'}
                </button>
                <div class="task-main">
                  <span class="task-title">{task.title}</span>
                  <span class="muted small">
                    {task.priority !== 'normal' && `${task.priority} · `}
                    {task.dueAt && (
                      <span class={late ? 'overdue' : undefined}>{clockTime(task.dueAt)}</span>
                    )}
                    {task.estimateMin && ` · ~${task.estimateMin}m`}
                    {task.tags.length > 0 && ` · ${task.tags.map((tag) => `#${tag}`).join(' ')}`}
                  </span>
                </div>
                <button type="button" class="task-remove" aria-label="Delete" onClick={() => void remove(task)}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export function JournalView({
  entries,
  day,
  locale,
  reload,
  onError,
}: {
  entries: JournalEntry[];
  day: string;
  locale: Locale;
  reload: () => void;
  onError: (error: Error) => void;
}) {
  const zh = locale === 'zh';
  const [text, setText] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const end = Date.now();
      await api.createJournal({ text: text.trim(), start: end - minutes * 60_000, end });
      setText('');
      reload();
    } catch (error) {
      onError(error as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title={zh ? '记录你做了什么' : 'Log what you did'}>
        <p class="muted small">
          {zh
            ? '数据能说出你在哪个窗口待了多久，说不出你其实在解决什么问题。这一段由你来写。'
            : 'The data knows which window you sat in. It cannot know what you were actually solving. That part is yours.'}
        </p>
        <textarea
          value={text}
          rows={3}
          placeholder={zh ? '这两个小时我在…' : 'For the last stretch I was…'}
          onInput={(event) => setText((event.currentTarget as HTMLTextAreaElement).value)}
        />
        <div class="journal-controls">
          <label>
            {zh ? '覆盖最近' : 'covers the last'}
            <select value={minutes} onChange={(event) => setMinutes(Number((event.currentTarget as HTMLSelectElement).value))}>
              {[15, 30, 45, 60, 90, 120, 180, 240].map((value) => (
                <option key={value} value={value}>
                  {value >= 60 ? `${value / 60}h` : `${value}m`}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!text.trim() || busy} onClick={() => void submit()}>
            {busy ? '…' : zh ? '记录' : 'Log'}
          </button>
        </div>
      </Card>

      <Card title={zh ? `${day} 的记录` : `Entries for ${day}`}>
        {entries.length === 0 ? (
          <Empty>{zh ? '这一天还没有记录。' : 'Nothing logged for this day.'}</Empty>
        ) : (
          <ul class="journal-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <span class="muted small">{clockTime(entry.start)}</span>
                <p>{entry.text}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function ReportsView({
  reports,
  day,
  locale,
  aiEnabled,
  reload,
  onError,
}: {
  reports: ReportRecord[];
  day: string;
  locale: Locale;
  aiEnabled: boolean;
  reload: () => void;
  onError: (error: Error) => void;
}) {
  const zh = locale === 'zh';
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [open, setOpen] = useState<number | null>(reports[0]?.id ?? null);
  const [preview, setPreview] = useState<ReportPreviewResponse | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const generate = async (statsOnly: boolean, confirmed = false) => {
    setBusy(true);
    try {
      if (!statsOnly && aiEnabled && !confirmed) {
        // Nothing is transmitted until the payload has been fetched and shown.
        // This is the difference between "we redact before sending" being a
        // claim and being something the user can look at.
        setPreview(await api.reportPreview(day));
        setShowPreview(true);
        return;
      }
      const record = await api.generateReport({
        day,
        kind: 'daily',
        statsOnly,
        ...(instruction.trim() && !statsOnly ? { instruction: instruction.trim() } : {}),
      });
      setOpen(record.id);
      setShowPreview(false);
      reload();
    } catch (error) {
      onError(error as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title={zh ? '生成诊断书' : 'Write the diagnosis'}>
        <p class="muted small">
          {aiEnabled
            ? zh
              ? 'AI 已启用。发送前内容经过脱敏，且你可以在下方补充要求。'
              : 'AI is on. The payload is redacted before it is sent, and you can add an instruction below.'
            : zh
              ? 'AI 未启用：报告完全由你自己的数字在本地生成，不需要联网。'
              : 'AI is off: the report is generated locally from your own numbers, with no network at all.'}
        </p>
        {aiEnabled && (
          <input
            type="text"
            value={instruction}
            placeholder={zh ? '额外要求，例如：重点分析下午为什么效率低' : 'Extra instruction, e.g. focus on why afternoons collapse'}
            onInput={(event) => setInstruction((event.currentTarget as HTMLInputElement).value)}
          />
        )}
        <div class="button-row">
          <button type="button" disabled={busy} onClick={() => void generate(true)}>
            {busy ? '…' : zh ? '本地生成' : 'Generate locally'}
          </button>
          {aiEnabled && (
            <button type="button" disabled={busy} onClick={() => void generate(false)}>
              {zh ? '用 AI 生成' : 'Generate with AI'}
            </button>
          )}
        </div>

        {aiEnabled && showPreview && preview && (
          <div class="preview">
            <div class="preview-head">
              <strong>{zh ? '即将发送以下内容' : 'About to send'}</strong>
              <span class="muted small">
                {preview.level} · {preview.bytes} bytes
                {preview.endpoint ? ` → ${preview.model}` : ''}
              </span>
            </div>
            {!preview.aiEnabled ? (
              <p class="muted small">
                {zh
                  ? '没有配置 AI key，因此不会发送任何内容。'
                  : 'No AI key is configured, so nothing would be sent.'}
              </p>
            ) : (
              <p class="muted small">
                {zh ? '将发送到 ' : 'Sending to '}
                <code>{preview.endpoint}</code>
              </p>
            )}
            <pre class="report-body">{JSON.stringify(preview.payload, null, 2)}</pre>
            <div class="button-row">
              <button
                type="button"
                disabled={busy || !preview.aiEnabled}
                onClick={() => void generate(false, true)}
              >
                {zh ? '确认并发送' : 'Send it'}
              </button>
              <button type="button" onClick={() => setShowPreview(false)}>
                {zh ? '取消' : 'Cancel'}
              </button>
              <button type="button" onClick={() => void generate(true)}>
                {zh ? '改用本地生成' : 'Use the local report instead'}
              </button>
            </div>
          </div>
        )}
      </Card>

      <Card title={zh ? '历史报告' : 'Earlier reports'}>
        {reports.length === 0 ? (
          <Empty>{zh ? '还没有报告。' : 'No reports yet.'}</Empty>
        ) : (
          <ul class="report-list">
            {reports.map((report) => (
              <li key={report.id}>
                <button
                  type="button"
                  class="report-head"
                  onClick={() => setOpen(open === report.id ? null : report.id)}
                >
                  <strong>{report.day}</strong>
                  <span class="muted small">
                    {report.model} · {clockTime(report.createdAt)}
                  </span>
                </button>
                {open === report.id && <pre class="report-body">{report.narrative}</pre>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function SettingsView({
  settings,
  locale,
  onLocale,
  reload,
  onError,
  token,
  onToken,
  connection,
  version,
}: {
  settings: PublicSettings;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  reload: () => void;
  onError: (error: Error) => void;
  token: string;
  onToken: (token: string) => void;
  connection: 'open' | 'closed';
  version: string;
}) {
  const zh = locale === 'zh';
  const [draftToken, setDraftToken] = useState(token);
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState(false);

  const patch = async (body: unknown) => {
    try {
      await api.updateSettings(body);
      reload();
    } catch (error) {
      onError(error as Error);
    }
  };

  const pairWithCode = async () => {
    if (!code.trim()) return;
    setPairing(true);
    try {
      const response = await api.pair({
        code: code.trim(),
        deviceName: `${navigator.platform || 'web'} browser`,
        platform: 'web',
      });
      onToken(response.token);
      setDraftToken(response.token);
      setCode('');
      reload();
    } catch (error) {
      onError(error as Error);
    } finally {
      setPairing(false);
    }
  };

  return (
    <>
      <Card title={zh ? '外观' : 'Appearance'}>
        <label class="field">
          <span>{zh ? '语言' : 'Language'}</span>
          <select
            value={locale}
            onChange={(event) => onLocale((event.currentTarget as HTMLSelectElement).value as Locale)}
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
        </label>
        <label class="field">
          <span>{zh ? '主题' : 'Theme'}</span>
          <select
            value={settings.ui.theme}
            onChange={(event) => void patch({ ui: { theme: (event.currentTarget as HTMLSelectElement).value } })}
          >
            <option value="system">{zh ? '跟随系统' : 'System'}</option>
            <option value="light">{zh ? '浅色' : 'Light'}</option>
            <option value="dark">{zh ? '深色' : 'Dark'}</option>
          </select>
        </label>
        <label class="field">
          <span>{zh ? '字号' : 'Font size'}</span>
          <input
            type="range"
            min="0.8"
            max="1.6"
            step="0.05"
            value={settings.ui.fontScale}
            onInput={(event) => void patch({ ui: { fontScale: Number((event.currentTarget as HTMLInputElement).value) } })}
          />
        </label>
        <label class="field">
          <span>{zh ? '字体' : 'Font family'}</span>
          <input
            type="text"
            value={settings.ui.fontFamily}
            placeholder={zh ? '留空使用系统字体' : 'empty uses the system font'}
            onChange={(event) => void patch({ ui: { fontFamily: (event.currentTarget as HTMLInputElement).value } })}
          />
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            checked={settings.ui.petEnabled}
            onChange={(event) => void patch({ ui: { petEnabled: (event.currentTarget as HTMLInputElement).checked } })}
          />
          {zh ? '显示桌宠' : 'Show the desktop pet'}
        </label>
      </Card>

      <Card title={zh ? '专注度权重' : 'Focus weights'}>
        <label class="field">
          <span>{zh ? '预设' : 'Preset'}</span>
          <select
            value={settings.focus.preset}
            onChange={(event) => void patch({ focus: { preset: (event.currentTarget as HTMLSelectElement).value } })}
          >
            <option value="balanced">{zh ? '均衡' : 'Balanced'}</option>
            <option value="deep">{zh ? '深度工作优先' : 'Depth first'}</option>
            <option value="calm">{zh ? '少打断优先' : 'Fewer interruptions'}</option>
            <option value="custom">{zh ? '自定义' : 'Custom'}</option>
          </select>
        </label>
        {settings.focus.preset === 'custom' &&
          Object.entries(settings.focus.weights).map(([key, value]) => (
            <label class="field" key={key}>
              <span>{key}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={value}
                onInput={(event) =>
                  void patch({
                    focus: { weights: { [key]: Number((event.currentTarget as HTMLInputElement).value) } },
                  })
                }
              />
            </label>
          ))}
        <p class="muted small">
          {zh
            ? '专注分完全由你掌控。换一组权重，历史数据会用新权重重新计算。'
            : 'The score is yours to define. Change the weights and history is recomputed with them.'}
        </p>
      </Card>

      <Card title={zh ? '隐私' : 'Privacy'}>
        <label class="toggle">
          <input
            type="checkbox"
            checked={settings.tracking.captureTitles}
            onChange={(event) =>
              void patch({ tracking: { captureTitles: (event.currentTarget as HTMLInputElement).checked } })
            }
          />
          {zh ? '记录窗口标题' : 'Record window titles'}
        </label>
        <p class="muted small">
          {zh
            ? '关闭后只记录程序名与分类，仍然算得出时间，但看不到具体页面。'
            : 'Turn this off and only the app and its category are stored. The time still adds up; the page does not.'}
        </p>
        <p class="muted small">
          {zh ? '已排除的程序：' : 'Excluded apps: '}
          {settings.tracking.excludeApps.join(', ') || '—'}
        </p>
        <p class="muted small">
          {zh
            ? `原始窗口记录保留 ${settings.tracking.segmentRetentionDays} 天，之后自动清理。`
            : `Raw segments are kept for ${settings.tracking.segmentRetentionDays} days, then pruned automatically.`}
        </p>
      </Card>

      <Card title={zh ? '这台设备' : 'This device'}>
        <p class="muted small">
          {zh ? '连接状态' : 'Connection'}: {connection === 'open' ? 'live' : 'reconnecting'} · v{version}
        </p>
        <label class="field">
          <span>{zh ? '配对令牌' : 'Pairing token'}</span>
          <input
            type="text"
            value={draftToken}
            placeholder={zh ? '本机访问不需要令牌' : 'not needed for localhost'}
            onInput={(event) => setDraftToken((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <div class="button-row">
          <button
            type="button"
            onClick={() => {
              onToken(draftToken.trim());
              reload();
            }}
          >
            {zh ? '保存令牌' : 'Save token'}
          </button>
          <button
            type="button"
            onClick={() => {
              onToken('');
              setDraftToken('');
            }}
          >
            {zh ? '清除' : 'Clear'}
          </button>
        </div>
        <p class="muted small">
          {zh
            ? '在这台电脑上打开不需要令牌。手机访问需要在电脑终端里运行 `attentio pair`，然后把六位码填在这里。'
            : 'No token is needed on this machine. For your phone, run `attentio pair` in the terminal and enter the six-digit code here.'}
        </p>
        <div class="quick-add">
          <input
            type="text"
            inputMode="numeric"
            value={code}
            placeholder={zh ? '六位配对码' : 'six-digit code'}
            onInput={(event) => setCode((event.currentTarget as HTMLInputElement).value)}
          />
          <button type="button" disabled={pairing || !code.trim()} onClick={() => void pairWithCode()}>
            {pairing ? '…' : zh ? '配对' : 'Pair'}
          </button>
        </div>
      </Card>
    </>
  );
}

export { Spinner, ErrorNote };
