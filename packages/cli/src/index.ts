#!/usr/bin/env node
/**
 * `attentio` — the command line.
 *
 * The CLI is the reference client: every feature the web UI has is reachable
 * here, which keeps the API honest and means the tool is usable over SSH or on a
 * machine with no browser. No argument-parsing dependency; the grammar is small
 * enough that a dependency would cost more than it saves.
 */

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAttentioServer,
  setReportGenerator,
  computeDay,
  computeTimeline,
  computeTrend,
  Db,
  Engine,
  buildRedactedPayload,
  chatEndpoint,
  createCollector,
  ensureHome,
  generateNarrative,
  loadConfig,
  paths,
  probeAi,
  renderReportMarkdown,
  saveConfig,
  toPublicSettings,
  type AttentioConfig,
} from '@attentio/daemon';
import { API_PREFIX, dayKey, categoryLabel, humanBytes, humanDuration, clockTime, CATEGORY_ORDER, categoryMeta } from '@attentio/shared';
import type { CategoryRule, DayStats } from '@attentio/shared';

import {
  bar,
  bullets,
  fail,
  heading,
  info,
  keyValue,
  ok,
  scoreColour,
  sparkline,
  style,
  table,
  truncateWide,
  warn,
  wrapText,
} from './terminal.ts';

const HELP = `${style.bold('attentio')} — know where your attention actually went

${style.bold('USAGE')}
  attentio <command> [options]

${style.bold('COMMANDS')}
  start                 Start tracking and serve the dashboard on your network
  today [--day D]       Summarise a day in the terminal
  report [--day D]      Write the day's diagnosis (--ai to use your model)
  why                   Explain how the current window is being classified
  tasks [list|add|done|rm]
  journal [text]        Show or add journal entries
  pair                  Print a pairing code for your phone
  trend [--days N]      Multi-day trend
  config [get|set|path] Read or change settings
  export [file]         Dump everything as JSON
  doctor                Report what Attentio can and cannot see
  backups               (planned) manage local snapshots

${style.bold('COMMON OPTIONS')}
  --home DIR            Use DIR instead of ~/.attentio
  --day YYYY-MM-DD      Pick a day (default: today)
  --json                Machine-readable output
  --zh | --en           Force report language
  -h, --help            Show this help

${style.dim('Data lives in ~/.attentio and never leaves this machine unless you enable --ai.')}
`;

interface Args {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token.startsWith('--')) {
      const [rawKey, inline] = token.slice(2).split('=', 2);
      const key = rawKey as string;
      if (inline !== undefined) {
        flags.set(key, inline);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (token.startsWith('-') && token.length > 1) {
      flags.set(token.slice(1), true);
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals.shift() ?? 'help', positionals, flags };
}

function flagString(args: Args, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

function flagBool(args: Args, key: string): boolean {
  return args.flags.get(key) === true || args.flags.get(key) === 'true';
}

function localeOf(args: Args, config: AttentioConfig): 'en' | 'zh' {
  if (flagBool(args, 'zh')) return 'zh';
  if (flagBool(args, 'en')) return 'en';
  return config.ui.locale;
}

async function openContext(args: Args): Promise<{
  config: AttentioConfig;
  db: Db;
  home: string;
}> {
  const home = flagString(args, 'home') ?? process.env['ATTENTIO_HOME'];
  const { config, file } = loadConfig(home ? { home } : {});
  ensureHome(home);
  const target = paths(home);
  void file;
  const db = new Db(target.db);
  return { config, db, home: target.home };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/**
 * Bind a port that is *actually* ours.
 *
 * Two failure modes make a plain `listen` untrustworthy. Another process may
 * already hold the port (EADDRINUSE), and on Windows a service bound to
 * 127.0.0.1:PORT can coexist with our 0.0.0.0:PORT while winning all loopback
 * traffic — so the daemon starts happily and the dashboard silently shows
 * somebody else's app. Asking our own health endpoint who is answering catches
 * both.
 */
async function listenVerified(
  base: Parameters<typeof createAttentioServer>[0] extends infer T ? Omit<T, 'port' | 'host'> : never,
  preferredPort: number,
  explicit: boolean,
): Promise<{ server: Awaited<ReturnType<typeof createAttentioServer>>; shifted: boolean }> {
  const attempts = explicit ? [preferredPort] : [preferredPort, 0];
  let lastError: unknown = null;

  for (const [index, port] of attempts.entries()) {
    let started: Awaited<ReturnType<typeof createAttentioServer>> | null = null;
    try {
      started = await createAttentioServer({ ...base, port });
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' && index < attempts.length - 1) continue;
      throw error;
    }
    if (await servesAttentio(started.port)) {
      return { server: started, shifted: port !== preferredPort };
    }
    lastError = new Error(`port ${port} is held by another service`);
    await started.close();
    if (index >= attempts.length - 1) break;
  }
  throw lastError ?? new Error('could not bind a port');
}

/**
 * Find the dashboard to serve.
 *
 * Order matters: a built bundle in the checkout is what a developer expects to
 * see, and ~/.attentio/web is what a packaged install would ship into.
 */
function resolveWebRoot(homeWeb: string): string | undefined {
  const candidates = [
    process.env['ATTENTIO_WEB_ROOT'],
    join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'apps', 'web', 'dist'),
    homeWeb,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

/** True when our own health endpoint answers on this loopback port. */
async function servesAttentio(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/health`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean; version?: string };
    return body.ok === true && typeof body.version === 'string';
  } catch {
    return false;
  }
}

async function cmdStart(args: Args): Promise<number> {
  const home = flagString(args, 'home') ?? process.env['ATTENTIO_HOME'];
  ensureHome(home);
  const { config } = loadConfig(home ? { home, create: true } : { create: true });
  const target = paths(home);
  // No saveConfig here on purpose: loadConfig({ create: true }) already wrote
  // defaults on first run, and re-saving would bake in any env overrides.
  void saveConfig;

  const db = new Db(target.db);
  db.upsertDevice({
    id: config.deviceId,
    name: config.deviceName,
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    hostname: '',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    trusted: true,
  });

  const collector = await createCollector();
  const status = collector.status();

  let onNewDay: ((day: string) => void) | undefined;
  const engine = new Engine({
    config,
    db,
    collector,
    ...(onNewDay ? { onNewDay } : {}),
  });

  const explicitPort = flagString(args, 'port');
  const { server, shifted } = await listenVerified(
    {
      config,
      db,
      engine,
      webRoot: resolveWebRoot(target.web),
      ...(flagString(args, 'host') ? { host: flagString(args, 'host') as string } : {}),
    },
    explicitPort ? Number(explicitPort) : config.remote.port,
    Boolean(explicitPort),
  );

  // Wire report generation so the HTTP API can produce reports too.
  setReportGenerator(async (request) => {
    const day = request.day ?? dayKey(Date.now());
    const dayData = computeDay({ db, config }, { day });
    const journal = db.listJournal({
      from: Date.parse(`${day}T00:00:00`),
      to: Date.parse(`${day}T00:00:00`) + 86_400_000,
    });
    const narrative = await generateNarrative({
      ai: {
        enabled: config.ai.enabled && config.ai.apiKey.length > 0,
        baseUrl: config.ai.baseUrl,
        apiKey: config.ai.apiKey,
        model: config.ai.model,
      },
      stats: dayData.stats,
      journal,
      locale: config.ui.locale,
      redaction: config.ai.redaction,
      statsOnly: request.statsOnly === true,
      ...(request.instruction ? { instruction: request.instruction } : {}),
    });
    const record = db.saveReport(
      {
        deviceId: config.deviceId,
        day,
        kind: request.kind ?? 'daily',
        stats: dayData.stats,
        narrative: narrative.text,
        model: narrative.model,
        createdAt: Date.now(),
        redacted: true,
      },
      { replace: true },
    );
    return record;
  });

  await engine.start();

  const pairing = server.createPairingCode();
  const label = (text: string) => style.bold(text);

  console.log(
    [
      '',
      `${style.cyan('◆')} ${label('Attentio')} ${style.gray(`v0.1.0 · ${target.home}`)}`,
      '',
      keyValue([
        ...(shifted
          ? ([
              [
                'note',
                style.yellow(
                  `port ${explicitPort ?? config.remote.port} was taken by another service — using ${server.port}`,
                ),
              ],
            ] as [string, string][])
          : []),
        ['dashboard', style.underline(server.url)],
        ...(server.lanUrls.length > 0
          ? ([['on your phone', style.underline(server.lanUrls[0] as string)]] as [string, string][])
          : []),
        ['pairing code', `${style.bold(pairing.code)} ${style.gray('(valid 5 minutes)')}`],
        ['collector', `${status.health === 'ok' ? style.green(status.health) : style.yellow(status.health)} ${style.gray(status.detail)}`],
        ['sampling', `${config.tracking.sampleIntervalMs} ms window · ${config.tracking.processIntervalMs} ms processes`],
        ['ai reports', config.ai.enabled ? style.green(`${config.ai.model} (redaction: ${config.ai.redaction})`) : style.gray('off — everything runs locally')],
      ]),
      '',
      style.gray('  Open the dashboard on this machine, or scan/enter the code on your phone.'),
      style.gray('  Press Ctrl+C to stop. Your data stays in ' + target.home + '.'),
      '',
    ].join('\n'),
  );

  // Task reminders: a plain interval is enough, and it keeps working when the
  // web UI is closed.
  const reminderTimer = setInterval(() => {
    const now = Date.now();
    for (const task of db.dueReminders(now, 0)) {
      console.log(`${style.yellow('⏰')} ${task.title} ${style.gray(`(due ${clockTime(task.dueAt ?? now)})`)}`);
      server.notify({
        type: 'reminder',
        at: now,
        task,
        message: task.title,
      });
      db.updateTask(task.id, { remindedAt: now });
    }
  }, 30_000);

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      console.log(`\n${style.gray(`${signal} received, flushing…`)}`);
      clearInterval(reminderTimer);
      void (async () => {
        await engine.stop();
        await server.close();
        db.close();
        console.log(ok(`Stopped. Data saved to ${target.db}`));
        resolve();
      })();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });

  return 0;
}

// ---------------------------------------------------------------------------
// today
// ---------------------------------------------------------------------------

function summarise(stats: DayStats, locale: 'en' | 'zh', mono: boolean): string {
  if (mono) return JSON.stringify(stats, null, 2);
  const zh = locale === 'zh';
  const out: string[] = [];

  out.push(heading(zh ? `今天 · ${stats.day}` : `Today · ${stats.day}`));

  if (stats.apps.length === 0 && stats.activeMs === 0) {
    out.push(
      warn(
        zh
          ? '这一天还没有任何记录。先运行 `attentio start`。'
          : 'Nothing recorded for this day yet. Run `attentio start` first.',
      ),
    );
    return out.join('\n');
  }

  const total = stats.activeMs + stats.idleMs;
  const rows: string[][] = [
    [
      zh ? '主动使用' : 'engaged',
      humanDuration(stats.activeMs),
      `${Math.round((stats.activeMs / Math.max(total, 1)) * 100)}%`,
      bar(stats.activeMs, total, 20, style.green),
    ],
    [
      zh ? '后台工作' : 'background',
      humanDuration(stats.backgroundMs),
      `${Math.round((stats.backgroundMs / Math.max(total, 1)) * 100)}%`,
      bar(stats.backgroundMs, total, 20, style.blue),
    ],
    [
      zh ? '离开' : 'away',
      humanDuration(stats.idleMs),
      `${Math.round((stats.idleMs / Math.max(total, 1)) * 100)}%`,
      bar(stats.idleMs, total, 20, style.gray),
    ],
  ];
  out.push(table([zh ? '账户' : 'account', zh ? '时长' : 'time', zh ? '占比' : 'share', ''], rows, { right: [1, 2] }));

  out.push(heading(zh ? '专注度' : 'Focus'));
  const colour = scoreColour(stats.focus.score);
  out.push(
    `  ${colour(style.bold(`${stats.focus.score}/100`))} ${style.gray(stats.focus.grade)} ${style.gray(`· ${zh ? '置信度' : 'confidence'} ${Math.round(stats.focus.confidence * 100)}%`)}`,
  );
  out.push('');
  for (const factor of stats.focus.factors) {
    const name = zh ? (factor.labelZh ?? factor.label) : factor.label;
    out.push(
      `  ${truncateWide(name, 14).padEnd(16)} ${bar(factor.value * 100, 100, 18, scoreColour(factor.value * 100))} ${style.gray(`×${factor.weight} → ${factor.contribution >= 0 ? '+' : ''}${factor.contribution.toFixed(1)}`)}`,
    );
  }
  if (stats.focus.notes.length > 0) {
    out.push('');
    out.push(bullets(stats.focus.notes.slice(0, 4)));
  }

  out.push(heading(zh ? '程序' : 'Apps'));
  out.push(
    table(
      [zh ? '程序' : 'app', zh ? '分类' : 'category', zh ? '前台' : 'foreground', zh ? '后台' : 'background', 'CPU'],
      stats.apps.slice(0, 12).map((app) => [
        truncateWide(app.app, 24),
        categoryLabel(app.category, locale),
        humanDuration(app.foregroundMs),
        humanDuration(app.backgroundMs),
        app.cpuMs > 0 ? humanDuration(app.cpuMs, { compact: true }) : '—',
      ]),
      { right: [2, 3, 4] },
    ),
  );

  out.push(heading(zh ? '时段' : 'When'));
  const byHour = new Array<number>(24).fill(0);
  for (const hour of stats.hours) byHour[hour.hour] = hour.foregroundMs;
  out.push(`  ${sparkline(byHour, 24)}  ${style.gray('0h → 23h')}`);
  const busiest = [...stats.hours].sort((a, b) => b.activeMs - a.activeMs)[0];
  if (busiest && busiest.activeMs > 0) {
    out.push(
      `  ${style.gray(zh ? '最集中的时段' : 'busiest hour')}: ${String(busiest.hour).padStart(2, '0')}:00 — ${humanDuration(busiest.activeMs)}${busiest.topApp ? ` ${style.gray(busiest.topApp)}` : ''}`,
    );
  }

  if (stats.blocks.length > 0) {
    out.push(heading(zh ? '专注块' : 'Focus blocks'));
    out.push(
      table(
        [zh ? '开始' : 'start', zh ? '时长' : 'length', zh ? '内容' : 'what'],
        stats.blocks.slice(0, 8).map((block) => [
          clockTime(block.start),
          humanDuration(block.activeMs),
          truncateWide(block.label || block.contexts.map((c) => c.context).filter(Boolean).join(', ') || '—', 40),
        ]),
        { right: [1] },
      ),
    );
  }

  if (stats.categories.length > 0) {
    out.push(heading(zh ? '分类' : 'Categories'));
    out.push(
      table(
        [zh ? '分类' : 'category', zh ? '时长' : 'time', zh ? '占比' : 'share', ''],
        stats.categories.slice(0, 8).map((category) => [
          categoryLabel(category.category, locale),
          humanDuration(category.ms),
          `${Math.round(category.share * 100)}%`,
          bar(category.share * 100, 100, 16, style.magenta),
        ]),
        { right: [1, 2] },
      ),
    );
  }

  out.push('');
  out.push(
    style.gray(
      `  ${stats.switches} ${zh ? '次窗口切换' : 'window switches'} · ${zh ? '峰值内存' : 'peak memory'} ${humanBytes(stats.peakMemBytes)} · CPU ${humanDuration(stats.cpuMs, { compact: true })}`,
    ),
  );

  return out.join('\n');
}

async function cmdToday(args: Args): Promise<number> {
  const { config, db } = await openContext(args);
  try {
    const day = flagString(args, 'day');
    const locale = localeOf(args, config);
    const response = computeDay({ db, config }, day ? { day } : {});
    if (flagBool(args, 'json')) {
      console.log(JSON.stringify(response, null, 2));
      return 0;
    }
    console.log(summarise(response.stats, locale, false));
    if (response.perDevice.length > 1) {
      console.log(heading(locale === 'zh' ? '各设备' : 'Per device'));
      console.log(
        table(
          [locale === 'zh' ? '设备' : 'device', locale === 'zh' ? '主动' : 'engaged', locale === 'zh' ? '后台' : 'background', locale === 'zh' ? '专注分' : 'score'],
          response.perDevice.map((stats) => {
            const device = response.devices.find((d) => d.id === stats.deviceId);
            return [
              device?.name ?? stats.deviceId.slice(0, 8),
              humanDuration(stats.activeMs),
              humanDuration(stats.backgroundMs),
              `${stats.focus.score}`,
            ];
          }),
          { right: [1, 2, 3] },
        ),
      );
    }
    console.log('');
    return 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

async function cmdReport(args: Args): Promise<number> {
  const { config, db } = await openContext(args);
  try {
    const day = flagString(args, 'day') ?? dayKey(Date.now());
    const locale = localeOf(args, config);
    const response = computeDay({ db, config }, { day });
    const anchor = Date.parse(`${day}T00:00:00`);
    const journal = db.listJournal({ from: anchor, to: anchor + 86_400_000 });

    const payload = buildRedactedPayload(response.stats, journal, {
      level: config.ai.redaction,
      locale,
      includeJournal: true,
    });
    const payloadText = JSON.stringify(payload, null, 2);
    const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
    const endpoint = `${config.ai.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const providerReady = config.ai.enabled && config.ai.apiKey.length > 0;

    // Show exactly what would leave, then stop. This is the check that makes
    // "we redact before sending" something a user can verify instead of believe.
    if (flagBool(args, 'preview') || flagBool(args, 'payload')) {
      console.log(heading(locale === 'zh' ? '将要发送的内容' : 'What would be sent'));
      console.log(
        style.gray(
          `  ${locale === 'zh' ? '脱敏级别' : 'redaction'} ${config.ai.redaction} · ${payloadBytes} bytes · ${config.ai.model}`,
        ),
      );
      console.log(
        style.gray(
          `  → ${providerReady ? endpoint : locale === 'zh' ? '(未配置 AI，不会发送任何内容)' : '(no AI configured — nothing would be sent)'}`,
        ),
      );
      console.log('');
      console.log(payloadText);
      return 0;
    }

    // Sending is opt-in per invocation. A report that quietly uploaded your day
    // because a key happened to be sitting in the config would be a betrayal of
    // the promise this tool is built on, so `--ai` is required and the payload
    // is shown first unless `--send` is passed.
    let useAi = flagBool(args, 'ai');
    if (useAi && !providerReady) {
      console.log(
        warn(locale === 'zh' ? '没有配置 AI key，改用本地报告。' : 'No AI key configured — using the offline report.'),
      );
      useAi = false;
    }
    if (useAi && !flagBool(args, 'send')) {
      console.log(heading(locale === 'zh' ? '即将发送以下内容' : 'About to send'));
      console.log(
        style.gray(`  ${config.ai.redaction} · ${payloadBytes} bytes · → ${endpoint} · ${config.ai.model}`),
      );
      console.log('');
      console.log(payloadText.length > 4000 ? `${payloadText.slice(0, 4000)}\n… (${payloadBytes} bytes total)` : payloadText);
      console.log('');
      if (process.stdin.isTTY) {
        const answer = await prompt(`Send this to ${config.ai.model}? [y/N] `);
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log(warn(locale === 'zh' ? '已取消，未发送任何内容。' : 'Cancelled — nothing was sent.'));
          useAi = false;
        }
      } else {
        // Non-interactive: never assume yes.
        console.log(
          warn(
            locale === 'zh'
              ? '当前不是交互终端，因此没有发送。确认上面的内容后加 --send 重试。'
              : 'Not a terminal, so nothing was sent. Re-run with --send once the payload above looks right.',
          ),
        );
        useAi = false;
      }
    }

    const outcome = await generateNarrative({
      ai: {
        enabled: useAi && config.ai.enabled && config.ai.apiKey.length > 0,
        baseUrl: config.ai.baseUrl,
        apiKey: config.ai.apiKey,
        model: config.ai.model,
      },
      stats: response.stats,
      journal,
      locale,
      redaction: config.ai.redaction,
      statsOnly: !useAi,
      ...(flagString(args, 'instruction') ? { instruction: flagString(args, 'instruction') as string } : {}),
    });

    if (outcome.fellBack) {
      console.log(warn(`AI report unavailable (${outcome.error ?? 'unknown'}) — showing the offline diagnosis.\n`));
    }
    console.log(outcome.text);

    db.saveReport(
      {
        deviceId: config.deviceId,
        day,
        kind: 'daily',
        stats: response.stats,
        narrative: outcome.text,
        model: outcome.model,
        createdAt: Date.now(),
        redacted: true,
      },
      { replace: true },
    );
    console.log(style.gray(`\n  saved to ${paths().db}`));
    return 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// why
// ---------------------------------------------------------------------------

async function cmdWhy(args: Args): Promise<number> {
  const { config, db } = await openContext(args);
  try {
    const collector = await createCollector();
    const sample = collector.sampleWindow(Date.now());
    collector.dispose();
    if (!sample) {
      console.log(fail('No foreground window is visible to Attentio right now.'));
      return 1;
    }
    const engine = new Engine({ config, db, collector });
    void engine;
    const { normalizeWindow, RuleSet, mergeRules, DEFAULT_RULES } = await import('@attentio/shared');
    const normalized = normalizeWindow({ exePath: sample.exePath, title: sample.title, appHint: sample.app });
    const rules = new RuleSet(mergeRules([], DEFAULT_RULES));
    const matchInput = {
      app: normalized.app,
      stem: normalized.stem,
      exePath: sample.exePath,
      title: sample.title,
    };
    const classification = rules.classify(matchInput);
    const matching = rules.matches(matchInput);

    console.log(heading('Why is this classified this way?'));
    console.log(
      keyValue([
        ['window title', truncateWide(sample.title || '(empty)', 64)],
        ['executable', truncateWide(sample.exePath || '(unavailable)', 64)],
        ['app name', normalized.app],
        ['context', normalized.context || '—'],
        ['category', `${categoryLabel(classification.category, localeOf(args, config))} (${classification.category})`],
        ['matched rule', classification.ruleId || '(none — fell through to the default)'],
        ['idle', humanDuration(sample.idleMs)],
      ]),
    );
    if (matching.length > 1) {
      console.log(heading('Rules that matched'));
      console.log(
        bullets(
          matching.map((m, index) =>
            index === 0
              ? `${style.green(m.id)} → ${m.category} ${style.gray(`(won; matched ${m.matchedOn.join(', ')})`)}`
              : `${style.gray(m.id)} → ${m.category} ${style.gray('(shadowed by the rule above)')}`,
          ),
        ),
      );
    }
    console.log('');
    console.log(
      style.gray(
        '  Categories are intentionally few and blunt. If this is wrong, add a rule in\n' +
          `  ${paths().config} under "rules".\n`,
      ),
    );
    return 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// tasks / journal
// ---------------------------------------------------------------------------

async function cmdTasks(args: Args): Promise<number> {
  const { config, db } = await openContext(args);
  const locale = localeOf(args, config);
  try {
    const sub = args.positionals[0] ?? 'list';
    const now = Date.now();

    if (sub === 'add') {
      const title = args.positionals.slice(1).join(' ').trim();
      if (!title) {
        console.log(fail('Usage: attentio tasks add "write the report" [--due 18:00] [--priority high]'));
        return 1;
      }
      const due = flagString(args, 'due');
      const task = db.createTask({
        deviceId: config.deviceId,
        title,
        notes: flagString(args, 'notes') ?? '',
        status: 'open',
        priority: (flagString(args, 'priority') as 'low' | 'normal' | 'high' | undefined) ?? 'normal',
        dueAt: due ? parseDue(due, now) : null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        source: 'user',
        tags: (flagString(args, 'tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        estimateMin: flagString(args, 'estimate') ? Number(flagString(args, 'estimate')) : null,
        remindedAt: null,
      });
      console.log(ok(`Added #${task.id}: ${task.title}${task.dueAt ? style.gray(` (due ${clockTime(task.dueAt)})`) : ''}`));
      return 0;
    }

    if (sub === 'done' || sub === 'rm' || sub === 'remove') {
      const id = Number(args.positionals[1]);
      if (!Number.isFinite(id)) {
        console.log(fail(`Usage: attentio tasks ${sub} <id>`));
        return 1;
      }
      if (sub === 'done') {
        const task = db.updateTask(id, { status: 'done', completedAt: now, remindedAt: null });
        console.log(task ? ok(`Completed #${id}: ${task.title}`) : fail(`No task with id ${id}`));
        return task ? 0 : 1;
      }
      console.log(db.deleteTask(id) ? ok(`Deleted #${id}`) : fail(`No task with id ${id}`));
      return 0;
    }

    const tasks = db.listTasks({ status: flagString(args, 'status') as never ?? 'all' });
    if (flagBool(args, 'json')) {
      console.log(JSON.stringify(tasks, null, 2));
      return 0;
    }
    console.log(heading(locale === 'zh' ? '待办' : 'Tasks'));
    if (tasks.length === 0) {
      console.log(style.gray(locale === 'zh' ? '  还没有待办。用 `attentio tasks add "..."` 添加。' : '  Nothing yet. Add one with `attentio tasks add "..."`.'));
      return 0;
    }
    console.log(
      table(
        ['#', locale === 'zh' ? '状态' : 'status', locale === 'zh' ? '任务' : 'task', locale === 'zh' ? '截止' : 'due', locale === 'zh' ? '优先级' : 'priority'],
        tasks.map((task) => [
          String(task.id),
          task.status === 'done' ? style.green('✔ done') : task.status === 'doing' ? style.cyan('▸ doing') : '○ open',
          truncateWide(task.title, 48),
          task.dueAt ? (task.dueAt < now && task.status !== 'done' ? style.red(clockTime(task.dueAt)) : clockTime(task.dueAt)) : '—',
          task.priority,
        ]),
      ),
    );
    console.log('');
    return 0;
  } finally {
    db.close();
  }
}

async function cmdJournal(args: Args): Promise<number> {
  const { config, db } = await openContext(args);
  try {
    const text = args.positionals.join(' ').trim();
    if (text) {
      const now = Date.now();
      const entry = db.createJournal({
        deviceId: config.deviceId,
        text,
        start: now - 30 * 60_000,
        end: now,
        tags: [],
        source: 'user',
        createdAt: now,
        reportId: null,
      });
      console.log(ok(`Logged #${entry.id}: ${entry.text}`));
      return 0;
    }
    const day = flagString(args, 'day');
    const anchor = day ? Date.parse(`${day}T00:00:00`) : now0();
    const entries = db.listJournal({ from: anchor, to: anchor + 86_400_000 });
    console.log(heading('Journal'));
    if (entries.length === 0) {
      console.log(style.gray('  Nothing logged. Add with `attentio journal "what I did"`.'));
      return 0;
    }
    for (const entry of entries) {
      console.log(`  ${style.gray(clockTime(entry.start))}  ${wrapText(entry.text, 70, '').trimStart()}`);
    }
    console.log('');
    return 0;
  } finally {
    db.close();
  }
}

function now0(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function parseDue(text: string, now: number): number | null {
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const time = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (time) {
    const date = new Date(now);
    date.setHours(Number(time[1]), Number(time[2]), 0, 0);
    if (date.getTime() < now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  const relative = /^\+?(\d+)(m|h|d)$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return now + amount * factor;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// pair / trend / config / export / doctor
// ---------------------------------------------------------------------------

async function cmdPair(args: Args): Promise<number> {
  const { config, db } = await openContext(args);
  try {
    const server = await createAttentioServer({
      config,
      db,
      engine: new Engine({ config, db, collector: await createCollector() }),
      port: 0,
    });
    const pairing = server.createPairingCode(Number(flagString(args, 'ttl') ?? 300_000));
    console.log(heading('Pair a device'));
    console.log(
      keyValue([
        ['code', style.bold(pairing.code)],
        ['expires', clockTime(pairing.expiresAt)],
        ['this machine', server.url],
        ...(server.lanUrls.length > 0 ? ([['on your phone', server.lanUrls[0] as string]] as [string, string][]) : []),
      ]),
    );
    console.log('');
    console.log(
      style.gray('  Start the daemon with `attentio start`, then open the LAN address on your\n' +
        '  phone and enter this code. The code is single-use.\n'),
    );
    await server.close();
    return 0;
  } finally {
    db.close();
  }
}

async function cmdTrend(args: Args): Promise<number> {
  const { config, db } = await openContext(args);
  const locale = localeOf(args, config);
  try {
    const days = Number(flagString(args, 'days') ?? 14);
    const response = computeTrend({ db, config }, { days });
    if (flagBool(args, 'json')) {
      console.log(JSON.stringify(response, null, 2));
      return 0;
    }
    console.log(heading(locale === 'zh' ? `最近 ${response.days.length} 天` : `Last ${response.days.length} days`));
    console.log(
      table(
        [locale === 'zh' ? '日期' : 'day', locale === 'zh' ? '主动' : 'active', locale === 'zh' ? '深度' : 'deep', locale === 'zh' ? '干扰' : 'distracting', locale === 'zh' ? '切换' : 'switches', locale === 'zh' ? '专注分' : 'score', ''],
        response.days.map((point) => [
          point.day.slice(5),
          humanDuration(point.activeMs, { compact: true }),
          humanDuration(point.deepMs, { compact: true }),
          point.distractingMs > 0 ? style.yellow(humanDuration(point.distractingMs, { compact: true })) : '—',
          String(point.switches),
          point.score > 0 ? scoreColour(point.score)(String(point.score)) : '—',
          point.score > 0 ? bar(point.score, 100, 12, scoreColour(point.score)) : '',
        ]),
        { right: [1, 2, 3, 4, 5] },
      ),
    );
    console.log('');
    return 0;
  } finally {
    db.close();
  }
}

async function cmdConfig(args: Args): Promise<number> {
  const home = flagString(args, 'home') ?? process.env['ATTENTIO_HOME'];
  const { config } = loadConfig(home ? { home, create: true } : { create: true });
  const sub = args.positionals[0] ?? 'show';

  if (sub === 'path') {
    console.log(paths(home).config);
    return 0;
  }

  if (sub === 'set') {
    const key = args.positionals[1];
    const value = args.positionals[2];
    if (!key || value === undefined) {
      console.log(fail('Usage: attentio config set <key> <value>'));
      console.log(style.gray('  keys: ui.theme ui.locale ui.fontScale tracking.idleThresholdSec'));
      console.log(style.gray('        tracking.captureTitles focus.preset ai.enabled ai.model ai.baseUrl'));
      return 1;
    }
    const parts = key.split('.');
    let target: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      const next = target[part];
      if (typeof next !== 'object' || next === null) {
        console.log(fail(`Unknown config path: ${key}`));
        return 1;
      }
      target = next as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1] as string;
    if (!(leaf in target)) {
      console.log(fail(`Unknown config key: ${key}`));
      return 1;
    }
    const existing = target[leaf];
    target[leaf] =
      typeof existing === 'number'
        ? Number(value)
        : typeof existing === 'boolean'
          ? value === 'true' || value === '1'
          : Array.isArray(existing)
            ? value.split(',').map((v) => v.trim()).filter(Boolean)
            : value;
    saveConfig(config, home ? { home } : {});
    console.log(ok(`${key} = ${JSON.stringify(target[leaf])}`));
    return 0;
  }

  console.log(JSON.stringify(toPublicSettings(config), null, 2));
  return 0;
}

async function cmdExport(args: Args): Promise<number> {
  const { db } = await openContext(args);
  try {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: '0.1.0',
      ...db.exportAll(),
    };
    const target = args.positionals[args.positionals[0] === 'export' ? 1 : 0] ?? flagString(args, 'out');
    const json = JSON.stringify(payload, null, 2);
    if (target) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(target, json, 'utf8');
      console.log(ok(`Wrote ${humanBytes(Buffer.byteLength(json))} to ${target}`));
      return 0;
    }
    console.log(json);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdDoctor(args: Args): Promise<number> {
  const home = flagString(args, 'home') ?? process.env['ATTENTIO_HOME'];
  ensureHome(home);
  const { config } = loadConfig(home ? { home, create: true } : { create: true });
  const target = paths(home);
  const collector = await createCollector();
  const status = collector.status();
  const sample = collector.sampleWindow(Date.now());
  const processes = collector.sampleProcesses(Date.now());
  const inventory = collector.sampleInventory(Date.now());
  const system = collector.sampleSystem(Date.now());

  if (flagBool(args, 'json')) {
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          home: target.home,
          configFile: target.config,
          database: target.db,
          collector: status,
          sample,
          processCount: processes.length,
          inventory,
          system,
        },
        null,
        2,
      ),
    );
    collector.dispose();
    return 0;
  }

  console.log(heading('Environment'));
  console.log(
    keyValue([
      ['node', `${process.version} (${process.platform}/${process.arch})`],
      ['home', target.home],
      ['config', target.config],
      ['database', target.db],
      ['exists', String((await import('node:fs')).existsSync(target.db))],
    ]),
  );

  console.log(heading('Collector'));
  const healthColour = status.health === 'ok' ? style.green : status.health === 'degraded' ? style.yellow : style.red;
  console.log(keyValue([['id', status.id], ['health', healthColour(status.health)], ['detail', status.detail]]));

  console.log(heading('Capabilities'));
  console.log(
    table(
      ['capability', 'available'],
      Object.entries(status.capabilities).map(([key, value]) => [key, value ? style.green('yes') : style.red('no')]),
    ),
  );

  console.log(heading('Live check'));
  console.log(
    keyValue([
      ['foreground window', sample ? truncateWide(`${sample.app} — ${sample.title || '(no title)'}`, 60) : style.red('not visible')],
      ['idle time', sample ? humanDuration(sample.idleMs) : '—'],
      ['processes sampled', String(processes.length)],
      ['visible windows', inventory ? `${inventory.windowCount} (${inventory.apps.length} apps)` : style.red('unavailable')],
      ['cpu load', system ? `${Math.round(system.cpuLoad * 100)}%` : '—'],
      ['memory', system ? `${humanBytes(system.memUsedBytes)} / ${humanBytes(system.memTotalBytes)}` : '—'],
    ]),
  );

  const busiest = processes.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 5);
  if (busiest.length > 0 && busiest[0]!.cpuPct > 0) {
    console.log(heading('Top CPU right now'));
    console.log(
      table(
        ['app', 'cpu', 'memory'],
        busiest.map((p) => [truncateWide(p.app, 30), `${p.cpuPct.toFixed(1)}%`, humanBytes(p.memBytes)]),
        { right: [1, 2] },
      ),
    );
  }

  // Which running apps has nobody classified yet? Printing a ready-to-paste
  // snippet turns "why is this unclassified?" into a one-minute fix, and it is
  // how the default ruleset is meant to grow from real machines.
  const { normalizeWindow, RuleSet, mergeRules, DEFAULT_RULES } = await import('@attentio/shared');
  const rules = new RuleSet(mergeRules(config.rules as CategoryRule[], DEFAULT_RULES));
  const unknown = new Map<string, { stem: string; app: string; memBytes: number; count: number }>();
  for (const process of processes) {
    const normalized = normalizeWindow({ exePath: process.exePath, title: '', appHint: process.app });
    if (!normalized.stem) continue;
    const category = rules.classify({
      app: normalized.app,
      stem: normalized.stem,
      exePath: process.exePath,
      title: '',
    }).category;
    if (category !== 'unknown') continue;
    const existing = unknown.get(normalized.stem);
    if (existing) {
      existing.memBytes += process.memBytes;
      existing.count += 1;
    } else {
      unknown.set(normalized.stem, {
        stem: normalized.stem,
        app: normalized.app,
        memBytes: process.memBytes,
        count: 1,
      });
    }
  }

  const unclassified = [...unknown.values()].sort((a, b) => b.memBytes - a.memBytes).slice(0, 6);
  console.log(heading('Unclassified apps'));
  if (unclassified.length === 0) {
    console.log(style.gray('  Every running app matched a rule.\n'));
  } else {
    console.log(
      table(
        ['exe stem', 'seen as', 'memory'],
        unclassified.map((entry) => [
          truncateWide(entry.stem, 26),
          truncateWide(entry.app, 26),
          humanBytes(entry.memBytes),
        ]),
        { right: [2] },
      ),
    );
    console.log('');
    console.log(style.gray('  Paste these into "rules" in config.json, then fix the categories:'));
    const snippet = unclassified.map((entry) => ({
      id: `user.${entry.stem.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`,
      category: 'deep-work',
      exe: [entry.stem],
    }));
    console.log(style.gray(`  ${JSON.stringify(snippet, null, 2).split('\n').join('\n  ')}`));
    console.log('');
    console.log(
      style.gray('  Valid categories: deep-work, learning, creative, reference, communication, admin,\n' +
        '  social, shopping, entertainment, system, idle, unknown\n'),
    );
  }

  console.log(heading('AI (optional)'));
  if (!config.ai.enabled || !config.ai.apiKey) {
    console.log(
      style.gray('  Off. Reports are generated locally from your own numbers.\n') +
        style.gray(`  To enable: attentio config set ai.enabled true && attentio config set ai.model <model>\n`),
    );
  } else {
    const probe = await probeAi({
      baseUrl: config.ai.baseUrl,
      apiKey: config.ai.apiKey,
      model: config.ai.model,
    });
    console.log(keyValue([['endpoint', chatEndpoint(config.ai.baseUrl)], ['model', config.ai.model], ['probe', probe.ok ? style.green(probe.detail) : style.red(probe.detail)]]));
  }

  console.log(heading('Categories'));
  console.log(
    bullets(
      CATEGORY_ORDER.slice(0, 12).map(
        (id) => `${categoryLabel(id, config.ui.locale).padEnd(14)} ${style.gray(categoryMeta(id).icon)} ${style.gray(categoryMeta(id).blurb)}`,
      ),
    ),
  );
  console.log('');

  collector.dispose();
  return status.health === 'ok' ? 0 : 0;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (flagBool(args, 'help') || args.command === 'help' || args.command === '--help') {
    console.log(HELP);
    return 0;
  }

  try {
    switch (args.command) {
      case 'start':
        return await cmdStart(args);
      case 'today':
        return await cmdToday(args);
      case 'report':
        return await cmdReport(args);
      case 'why':
        return await cmdWhy(args);
      case 'tasks':
        return await cmdTasks(args);
      case 'journal':
        return await cmdJournal(args);
      case 'pair':
        return await cmdPair(args);
      case 'trend':
        return await cmdTrend(args);
      case 'config':
        return await cmdConfig(args);
      case 'export':
        return await cmdExport(args);
      case 'doctor':
        return await cmdDoctor(args);
      default:
        console.log(fail(`Unknown command: ${args.command}\n`));
        console.log(HELP);
        return 1;
    }
  } catch (error) {
    console.log(fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));
    return 1;
  }
}

/**
 * Ask a question on the terminal.
 *
 * Only ever called when stdin is a TTY, so a piped or scheduled run can never
 * end up blocking on a prompt nobody will answer.
 */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

void info;

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
