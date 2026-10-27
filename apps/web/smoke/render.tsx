/**
 * Render smoke test for the dashboard.
 *
 * There is no browser in CI and no screenshot in the terminal, so this renders
 * every view with a realistic synthetic day and asserts the output contains the
 * things a person would look for. It catches the failures that matter most in a
 * UI nobody can watch: a crash from a missing field, a chart that silently
 * renders nothing, a screen that shows zeros because a name changed.
 *
 * Run with `npm run smoke --workspace apps/web`.
 */

import { render } from 'preact-render-to-string';
import type {
  ActivitySegment,
  DayResponse,
  DayStats,
  FocusBlock,
  JournalEntry,
  LiveStatus,
  PublicSettings,
  ReportRecord,
  Task,
} from '@attentio/shared';

import { JournalView, ReportsView, SettingsView, TasksView } from '../src/capture.tsx';
import { Pet, deriveMood } from '../src/pet.tsx';
import { ReminderStack } from '../src/ui.tsx';
import { isSpeechSupported, speechLeavesDevice } from '../src/voice.ts';
import { AppsView, FocusView, TimelineView, TodayView } from '../src/views.tsx';

// ---------------------------------------------------------------------------
// Minimal DOM, since these components touch localStorage and window.
// ---------------------------------------------------------------------------

const store = new Map<string, string>();

/**
 * Node 24 defines some of these as getter-only globals, so plain assignment
 * throws. defineProperty with configurable is the portable way to install a stub.
 *
 * The stub `window` below is a plain object rather than the global object, so a
 * module that reads a browser API as `window.SpeechRecognition` would not see it.
 * In a real browser those are the same property, so mirror onto the stub too —
 * otherwise the harness silently reports "unsupported" for an API it was just
 * handed, which is exactly how the voice checks first failed.
 */
function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const stub = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (name !== 'window' && stub && typeof stub === 'object') stub[name] = value;
}

defineGlobal('window', {
  innerWidth: 390,
  innerHeight: 844,
  location: { hash: '#/today' },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setTimeout: () => 0,
  clearTimeout: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
  history: { replaceState: () => undefined },
});
defineGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
});
defineGlobal('navigator', { platform: 'test', serviceWorker: undefined });
defineGlobal('location', { hash: '#/today', protocol: 'http:' });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = '2026-03-02';
const HOUR = 3_600_000;
const base = Date.parse(`${DAY}T09:00:00`);

const focusFactors: DayStats['focus']['factors'] = [
  {
    id: 'engagement',
    label: 'Engagement',
    labelZh: '在场度',
    value: 0.72,
    weight: 0.1,
    contribution: 0.07,
    detail: '72% of observed time had real input.',
  },
  { id: 'depth', label: 'Depth', labelZh: '深度', value: 0.61, weight: 0.45, contribution: 27.4, detail: '61% deep work.' },
  {
    id: 'continuity',
    label: 'Continuity',
    labelZh: '连续性',
    value: 0.48,
    weight: 0.2,
    contribution: 9.6,
    detail: 'Longest unbroken stretch was 48 minutes.',
  },
  {
    id: 'fragmentation',
    label: 'Fragmentation',
    labelZh: '碎片度',
    value: 0.5,
    weight: 0.15,
    contribution: 7.5,
    detail: '186 switches across 5.5 hours of engaged time.',
  },
  {
    id: 'coherence',
    label: 'Coherence',
    labelZh: '一致性',
    value: 0.66,
    weight: 0.1,
    contribution: 6.6,
    detail: 'Deep work and learning made up most of the day.',
  },
];

const blocks: FocusBlock[] = [
  {
    deviceId: 'local',
    start: base,
    end: base + 95 * 60_000,
    activeMs: 95 * 60_000,
    score: 82,
    category: 'deep-work',
    label: 'Attentio',
    apps: ['VS Code', 'Windows Terminal'],
    switchCount: 6,
    contexts: [{ context: 'attentio — engine.ts', ms: 3_600_000 }],
  },
  {
    deviceId: 'local',
    start: base + 4 * HOUR,
    end: base + 4 * HOUR + 42 * 60_000,
    activeMs: 42 * 60_000,
    score: 64,
    category: 'learning',
    label: 'Operating systems',
    apps: ['Chrome'],
    switchCount: 11,
    contexts: [{ context: 'Lecture 12 — scheduling', ms: 2_400_000 }],
  },
];

const stats: DayStats = {
  // Matches the daemon's sentinel for "every paired device", which is what the
  // dashboard asks for by default.
  deviceId: 'all',
  day: DAY,
  firstSeen: base,
  lastSeen: base + 9 * HOUR,
  spanMs: 9 * HOUR,
  activeMs: 5.5 * HOUR,
  backgroundMs: 1.25 * HOUR,
  idleMs: 2.25 * HOUR,
  cpuMs: 42 * 60_000,
  switches: 186,
  peakMemBytes: 9_400_000_000,
  longestBlockMs: 95 * 60_000,
  apps: [
    {
      app: 'VS Code',
      category: 'deep-work',
      foregroundMs: 3.2 * HOUR,
      backgroundMs: 0.2 * HOUR,
      cpuMs: 18 * 60_000,
      peakMemBytes: 2_100_000_000,
      switches: 74,
      contexts: [
        { context: 'attentio — engine.ts', ms: 1.8 * HOUR },
        { context: 'attentio — server.ts', ms: 1.1 * HOUR },
      ],
    },
    {
      app: 'Chrome',
      category: 'reference',
      foregroundMs: 1.1 * HOUR,
      backgroundMs: 0.35 * HOUR,
      cpuMs: 9 * 60_000,
      peakMemBytes: 3_400_000_000,
      switches: 68,
      contexts: [{ context: 'MDN — EventSource', ms: 1_800_000 }],
    },
    {
      app: 'WeChat',
      category: 'communication',
      foregroundMs: 0.6 * HOUR,
      backgroundMs: 0.5 * HOUR,
      cpuMs: 3 * 60_000,
      peakMemBytes: 700_000_000,
      switches: 33,
      contexts: [],
    },
    {
      app: 'Steam',
      category: 'entertainment',
      foregroundMs: 0.4 * HOUR,
      backgroundMs: 0.2 * HOUR,
      cpuMs: 6 * 60_000,
      peakMemBytes: 1_200_000_000,
      switches: 11,
      contexts: [],
    },
  ],
  categories: [
    { category: 'deep-work', ms: 3.2 * HOUR, share: 0.51 },
    { category: 'reference', ms: 1.1 * HOUR, share: 0.18 },
    { category: 'communication', ms: 0.6 * HOUR, share: 0.1 },
    { category: 'entertainment', ms: 0.4 * HOUR, share: 0.06 },
  ],
  hours: Array.from({ length: 24 }, (_, hour) => {
    const active = hour >= 9 && hour <= 18 ? (hour % 3 === 0 ? 42 * 60_000 : 18 * 60_000) : 0;
    return {
      hour,
      foregroundMs: active,
      backgroundMs: hour >= 9 && hour <= 18 ? 5 * 60_000 : 0,
      activeMs: active,
      // Roughly one switch every five engaged minutes, which is what a normal day
      // produces. A fixture of zeros would render a flat chart and hide a broken
      // sparkline, which is the one thing this test exists to catch.
      switches: Math.round(active / 300_000),
      topApp: hour >= 9 && hour <= 18 ? 'VS Code' : '',
    };
  }),
  blocks,
  focus: {
    score: 68,
    grade: 'B',
    confidence: 0.82,
    factors: focusFactors,
    notes: ['Switch rate was high in the afternoon.', 'Deep work is concentrated before lunch.'],
  },
};

const dayResponse: DayResponse = {
  day: DAY,
  stats,
  perDevice: [stats],
  devices: [
    {
      id: 'all',
      name: 'All devices',
      platform: 'win32',
      hostname: '',
      createdAt: base,
      lastSeenAt: base,
      trusted: true,
    },
  ],
  rollupsIncluded: true,
};

const segments: ActivitySegment[] = [
  {
    deviceId: 'd1',
    app: 'VS Code',
    exePath: 'C:\\Code.exe',
    context: 'attentio — engine.ts',
    detail: 'engine.ts',
    title: 'engine.ts — attentio',
    category: 'deep-work',
    ruleId: 'dev.vscode',
    start: base,
    end: base + 25 * 60_000,
    idleEnd: false,
  },
  {
    deviceId: 'd1',
    app: 'Chrome',
    exePath: 'C:\\chrome.exe',
    context: 'MDN — EventSource',
    detail: '',
    title: 'EventSource — MDN',
    category: 'reference',
    ruleId: 'site.reference',
    start: base + 25 * 60_000,
    end: base + 29 * 60_000,
    idleEnd: false,
  },
  {
    deviceId: 'd1',
    app: 'Steam',
    exePath: 'C:\\Steam.exe',
    context: '',
    detail: '',
    title: 'Steam',
    category: 'entertainment',
    ruleId: 'fun.steam',
    start: base + 4 * HOUR,
    end: base + 5 * HOUR,
    idleEnd: true,
  },
];

const tasks: Task[] = [
  {
    id: 1,
    deviceId: 'd1',
    title: 'Write the Attentio final report',
    notes: '',
    status: 'doing',
    priority: 'high',
    dueAt: base + 2 * HOUR,
    createdAt: base,
    updatedAt: base,
    completedAt: null,
    source: 'user',
    tags: ['attentio'],
    estimateMin: 45,
    remindedAt: null,
  },
  {
    id: 2,
    deviceId: 'd1',
    title: 'Review classification rules',
    notes: '',
    status: 'done',
    priority: 'normal',
    dueAt: null,
    createdAt: base - HOUR,
    updatedAt: base,
    completedAt: base,
    source: 'user',
    tags: [],
    estimateMin: null,
    remindedAt: null,
  },
];

const journal: JournalEntry[] = [
  {
    id: 1,
    deviceId: 'd1',
    text: 'Fixed the rule engine so exe and app OR together.',
    start: base,
    end: base + HOUR,
    tags: [],
    source: 'user',
    createdAt: base,
    reportId: null,
  },
];

const reports: ReportRecord[] = [
  {
    id: 1,
    deviceId: 'd1',
    day: DAY,
    kind: 'daily',
    stats,
    narrative: '# Diagnosis\n\nYou did the work.\n',
    model: 'offline',
    createdAt: base,
    redacted: true,
  },
];

const settings: PublicSettings = {
  ai: {
    enabled: true,
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    redaction: 'app',
    dailyReportHour: 21,
    autoReports: false,
    hasApiKey: true,
    language: 'en',
  },
  tracking: {
    idleThresholdSec: 120,
    sampleIntervalMs: 1000,
    processIntervalMs: 5000,
    segmentRetentionDays: 90,
    captureTitles: true,
    reminderLeadMin: 5,
    dayStartHour: 4,
    excludeApps: ['1password', 'bitwarden'],
    excludeTitlePatterns: [],
  },
  focus: { preset: 'custom', weights: { engagement: 0.1, depth: 0.45, continuity: 0.2, fragmentation: 0.15, coherence: 0.1 }, minBlockMin: 5 },
  ui: { theme: 'dark', locale: 'en', petEnabled: true, petSkin: 'sprout', fontScale: 1, fontFamily: '' },
  remote: { bindHost: '0.0.0.0', port: 8787, enabled: true },
};

const live: LiveStatus = {
  deviceId: 'local',
  deviceName: 'XDDDC (win32)',
  platform: 'win32',
  current: { app: 'VS Code', context: 'engine.ts', category: 'deep-work', since: Date.now() - 52 * 60_000 },
  away: false,
  lastSampleAgeSec: 1,
  cpuLoad: 0.18,
  memUsedBytes: 20_000_000_000,
  memTotalBytes: 34_000_000_000,
  topCpu: [{ app: 'node', cpuPct: 12.4, memBytes: 400_000_000 }],
  upcoming: tasks.slice(0, 1),
};

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function expect(label: string, html: string, needles: string[]): void {
  for (const needle of needles) {
    checks++;
    if (!html.includes(needle)) {
      failures++;
      console.error(`  ✖ ${label}: missing ${JSON.stringify(needle)}`);
    }
  }
}

function expectThat(label: string, condition: boolean, detail = ''): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  ✖ ${label}${detail ? ': ' + detail : ''}`);
  }
}

function expectNot(label: string, html: string, needle: string): void {
  checks++;
  if (html.includes(needle)) {
    failures++;
    console.error(`  ✖ ${label}: unexpectedly contains ${JSON.stringify(needle)}`);
  }
}

const noop = () => undefined;

console.log('attentio web render smoke test\n');

{
  const html = render(
    <TodayView day={DAY} data={dayResponse} trend={null} locale="en" onDay={noop} onOpenApp={noop} />,
  );
  expect('today', html, [
    'engaged',
    'background',
    'away',
    '5h 30m',
    'Focus',
    '68',
    'VS Code',
    'WeChat',
    'deep-work'.replace('deep-work', 'Deep work'),
    'hour-strip',
    'account-bar',
  ]);
}

{
  const html = render(
    <TodayView day={DAY} data={dayResponse} trend={null} locale="zh" onDay={noop} onOpenApp={noop} />,
  );
  expect('today (zh)', html, ['主动使用', '后台工作', '离开', '深度工作', '专注度']);
}

{
  const html = render(
    <TimelineView day={DAY} segments={segments} truncated={false} locale="en" onDay={noop} />,
  );
  expect('timeline', html, ['Timeline', 'attentio — engine.ts', 'Entertainment', 'ended idle']);
}

{
  const html = render(<AppsView data={dayResponse} locale="en" filter="" onFilter={noop} />);
  expect('apps', html, ['Apps', 'VS Code', 'Windows and pages', 'attentio — server.ts']);
}

{
  const html = render(<AppsView data={dayResponse} locale="en" filter="steam" onFilter={noop} />);
  expect('apps filtered', html, ['Steam']);
  expectNot('apps filtered', html, 'WeChat');
}

{
  const html = render(
    <FocusView day={DAY} blocks={blocks} minBlockMs={5 * 60_000} locale="en" onDay={noop} />,
  );
  expect('focus', html, ['Focus blocks', 'Operating systems', 'Attentio', 'block-list']);
}

{
  const html = render(<FocusView day={DAY} blocks={[]} minBlockMs={5 * 60_000} locale="en" onDay={noop} />);
  expect('focus empty', html, ['No sustained focus blocks']);
}

{
  const html = render(<TasksView tasks={tasks} locale="en" reload={noop} onError={noop} />);
  expect('tasks', html, ['Write the Attentio final report', 'high', 'Show completed']);
  // A finished task must not clutter the default view.
  expectNot('tasks', html, 'Review classification rules');
}

{
  const html = render(<JournalView entries={journal} day={DAY} locale="en" reload={noop} onError={noop} />);
  expect('journal', html, ['Log what you did', 'Fixed the rule engine']);
}

{
  const html = render(
    <ReportsView reports={reports} day={DAY} locale="en" aiEnabled reload={noop} onError={noop} />,
  );
  expect('reports', html, ['Write the diagnosis', 'Generate with AI', 'Diagnosis']);
}

{
  const html = render(
    <SettingsView
      settings={settings}
      locale="en"
      onLocale={noop}
      reload={noop}
      onError={noop}
      token=""
      onToken={noop}
      connection="open"
      version="0.1.0"
      notifications="granted"
      onRequestNotifications={noop}
    />,
  );
  expect('settings', html, ['Appearance', 'Focus weights', 'Privacy', 'attentio pair', '1password']);
}

// Every permission state must render something a person can act on. 'denied' is
// the important one: the browser will not ask again, so the copy has to say so,
// and the page has to remain the thing that delivers reminders.
for (const state of ['unsupported', 'default', 'granted', 'denied'] as const) {
  const html = render(
    <SettingsView
      settings={settings}
      locale="en"
      onLocale={noop}
      reload={noop}
      onError={noop}
      token=""
      onToken={noop}
      connection="open"
      version="0.1.0"
      notifications={state}
      onRequestNotifications={noop}
    />,
  );
  const hasReminderCopy = html.includes('Browser notifications');
  const offersButton = html.includes('Enable notifications');
  expectThat(`notification state "${state}" has copy`, hasReminderCopy);
  // Only the undecided state should offer the button; offering it after a denial
  // would be a button that does nothing, which is worse than no button.
  expectThat(
    `notification state "${state}" button visibility`,
    offersButton === (state === 'default'),
    `button=${offersButton}, expected ${state === 'default'}`,
  );
  if (state === 'denied') {
    expectThat('a denied permission says reminders still appear', html.includes('still appear'));
  }
}

// The in-page stack is the delivery path that does not depend on any permission.
{
  const html = render(
    <ReminderStack
      reminders={[
        { id: 't1', message: 'Submit the lab report', taskId: 7, dueAt: Date.now() + 300_000 },
        { id: 't2', message: 'Call the bank' },
      ]}
      onDismiss={noop}
      onComplete={noop}
    />,
  );
  expect('reminders', html, ['Submit the lab report', 'Call the bank', 'Done', 'Dismiss reminder']);
}

// With nothing pending it must render nothing at all, rather than an empty box
// that pushes the layout around on every page.
{
  const html = render(<ReminderStack reminders={[]} onDismiss={noop} onComplete={noop} />);
  expectThat('an empty reminder stack renders nothing', html === '', `got ${JSON.stringify(html)}`);
}

// Voice is optional and must degrade to absence, not to a dead button. The
// smoke environment has no SpeechRecognition, which is the Firefox case.
{
  expectThat('speech is reported unsupported without the API', !isSpeechSupported());
  const html = render(<TasksView tasks={tasks} locale="en" reload={noop} onError={noop} />);
  expectNot('no microphone button without speech support', html, 'Speak a task');
  expect('tasks still usable by keyboard', html, ['What next?', 'Add']);

  // Now pretend the browser has it, which is the Chrome case.
  class FakeRecognition {
    lang = '';
    continuous = true;
    interimResults = false;
    maxAlternatives = 1;
    // Typed explicitly: inferring from `null` makes them non-callable.
    onresult: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onend: (() => void) | null = null;
    onstart: (() => void) | null = null;
    start(): void {
      this.onstart?.();
    }
    stop(): void {
      this.onend?.();
    }
    abort(): void {
      /* nothing to abort in the fake */
    }
  }
  defineGlobal('SpeechRecognition', FakeRecognition);
  const withSpeech = render(<TasksView tasks={tasks} locale="en" reload={noop} onError={noop} />);
  expect('a microphone button appears when the browser can listen', withSpeech, ['Speak a task']);
  expectThat('speech is reported supported with the API', isSpeechSupported());
  // Unsupported should now be false, which is what gates the button.
  expectThat(
    'the disclosure is honest that audio leaves the device',
    speechLeavesDevice(),
    'the browser Speech API is a cloud service in Chromium',
  );
}

// The pet's mood must come from the data, not from nothing.
{
  const focused = deriveMood({ live, stats, locale: 'en', skin: 'sprout', size: 96 });
  checks++;
  if (focused.mood !== 'celebrating' && focused.mood !== 'focused') {
    failures++;
    console.error(`  ✖ pet: a 52-minute deep-work stretch should read as focused, got ${focused.mood}`);
  }

  const away = deriveMood({ live: { ...live, away: true, current: null }, stats, locale: 'en', skin: 'sprout', size: 96 });
  checks++;
  if (away.mood !== 'away') {
    failures++;
    console.error(`  ✖ pet: away status should read as away, got ${away.mood}`);
  }

  const gaming = deriveMood({
    live: { ...live, current: { ...live.current!, app: 'Steam', category: 'entertainment', since: Date.now() - 40 * 60_000 } },
    stats,
    locale: 'en',
    skin: 'sprout',
    size: 96,
  });
  checks++;
  if (gaming.mood !== 'distracted') {
    failures++;
    console.error(`  ✖ pet: entertainment should read as distracted, got ${gaming.mood}`);
  }

  for (const skin of ['sprout', 'cat', 'blob', 'robot'] as const) {
    const html = render(
      <Pet live={live} stats={stats} locale="en" skin={skin} size={96} onOpenSettings={noop} />,
    );
    expect(`pet (${skin})`, html, ['pet-body']);
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failed`);
  process.exitCode = 1;
}
