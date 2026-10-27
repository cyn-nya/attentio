/**
 * Reports: the "diagnosis" (诊断书) and "work log" (工作日志).
 *
 * Two things are generated here, and the distinction matters:
 *
 *   1. A **deterministic** narrative built purely from your own numbers. It
 *      works with no network, no API key and no account, and it is the default.
 *   2. A **redacted payload** suitable for an LLM, when you explicitly turn AI
 *      reports on. The payload is built from aggregate statistics, never raw
 *      window titles, and the caller can show it to the user before sending.
 *
 * The deterministic text is not a placeholder for the AI one. A tracker that
 * cannot explain a day without a cloud service is a tracker that stops working
 * the moment the network does.
 */

import { GRADE_BLURB, categoryLabel, clockTime, humanDuration, percent } from '@attentio/shared';
import type { ActivitySegment, DayStats, JournalEntry, ReportKind } from '@attentio/shared';

export type Locale = 'en' | 'zh';
export type RedactionLevel = 'app' | 'context' | 'full';

export interface ReportBundle {
  day: string;
  kind: ReportKind;
  stats: DayStats;
  journal: JournalEntry[];
  markdown: string;
}

export interface NarrativeOptions {
  locale?: Locale;
  journal?: readonly JournalEntry[];
  /** Cap displayed apps so the report stays readable. */
  topApps?: number;
}

/**
 * Deterministic diagnosis. Every sentence is derived from a number that is also
 * printed, so a reader can check the claim instead of trusting it.
 */
export function renderReportMarkdown(stats: DayStats, options: NarrativeOptions = {}): string {
  const locale = options.locale ?? 'en';
  const zh = locale === 'zh';
  const topApps = options.topApps ?? 8;
  const journal = options.journal ?? [];
  const lines: string[] = [];

  const L = {
    title: zh ? `# 诊断书 · ${stats.day}` : `# Diagnosis · ${stats.day}`,
    scope: zh ? '## 这一天的账' : '## How the day was spent',
    focus: zh ? '## 专注度' : '## Focus',
    factors: zh ? '### 五个因子' : '### The five factors',
    apps: zh ? '## 时间去了哪里' : '## Where the time went',
    blocks: zh ? '## 深度工作块' : '## Focus blocks',
    journal: zh ? '## 你记录的' : '## What you logged',
    observe: zh ? '## 观察' : '## What stands out',
    suggest: zh ? '## 建议' : '## What to try',
    confidence: zh ? '置信度' : 'confidence',
    engaged: zh ? '主动使用' : 'engaged',
    background: zh ? '后台工作' : 'background',
    away: zh ? '离开' : 'away',
    switches: zh ? '窗口切换' : 'switches',
    cpu: zh ? 'CPU 时间' : 'CPU time',
    longest: zh ? '最长专注块' : 'longest focus block',
    peakMem: zh ? '峰值内存' : 'peak memory',
    none: zh ? '（没有记录）' : '(nothing recorded)',
    unaccounted: zh ? '未记录' : 'unobserved',
  };

  lines.push(L.title, '');

  // ---------------------------------------------------------------- accounts
  const accounted = stats.activeMs + stats.idleMs;
  lines.push(L.scope, '');
  lines.push(`| | ${zh ? '时长' : 'time'} | ${zh ? '占比' : 'share'} |`);
  lines.push('|---|---:|---:|');
  lines.push(`| ${L.engaged} | ${humanDuration(stats.activeMs)} | ${percent(stats.activeMs, accounted)} |`);
  lines.push(
    `| ${L.background} | ${humanDuration(stats.backgroundMs)} | ${percent(stats.backgroundMs, accounted)} |`,
  );
  lines.push(`| ${L.away} | ${humanDuration(stats.idleMs)} | ${percent(stats.idleMs, accounted)} |`);
  lines.push('');

  const meta: string[] = [];
  if (stats.firstSeen && stats.lastSeen) {
    meta.push(
      zh
        ? `观测区间 ${clockTime(stats.firstSeen)} – ${clockTime(stats.lastSeen)}`
        : `Observed ${clockTime(stats.firstSeen)} – ${clockTime(stats.lastSeen)}`,
    );
  }
  meta.push(`${L.switches} ${stats.switches}`);
  if (stats.cpuMs > 0) meta.push(`${L.cpu} ${humanDuration(stats.cpuMs)}`);
  if (stats.peakMemBytes > 0) meta.push(`${L.peakMem} ${Math.round(stats.peakMemBytes / 1048576)} MB`);
  lines.push(meta.join(' · '), '');

  // ------------------------------------------------------------------ focus
  lines.push(L.focus, '');
  lines.push(
    `**${stats.focus.score}/100 · ${stats.focus.grade}** — ${GRADE_BLURB[stats.focus.grade] ?? stats.focus.grade}  `,
  );
  lines.push(`*${L.confidence}: ${Math.round(stats.focus.confidence * 100)}%*`, '');
  lines.push(L.factors, '');
  for (const factor of stats.focus.factors) {
    const label = zh ? (factor.labelZh ?? factor.label) : factor.label;
    lines.push(
      `- **${label}** ${Math.round(factor.value * 100)}/100 · ×${factor.weight} → ${factor.contribution >= 0 ? '+' : ''}${factor.contribution.toFixed(1)}`,
    );
    if (factor.detail) lines.push(`  - ${factor.detail}`);
  }
  lines.push('');

  // ------------------------------------------------------------------- apps
  lines.push(L.apps, '');
  lines.push(
    zh
      ? '| 程序 | 分类 | 前台 | 后台 | CPU |'
      : '| App | Category | Foreground | Background | CPU |',
  );
  lines.push('|---|---|---:|---:|---:|');
  for (const app of stats.apps.slice(0, topApps)) {
    lines.push(
      `| ${app.app} | ${categoryLabel(app.category, locale)} | ${humanDuration(app.foregroundMs)} | ${humanDuration(app.backgroundMs)} | ${humanDuration(app.cpuMs)} |`,
    );
  }
  lines.push('');

  // ----------------------------------------------------------------- blocks
  if (stats.blocks.length > 0) {
    lines.push(L.blocks, '');
    for (const block of stats.blocks.slice(0, 6)) {
      const contexts = block.contexts
        .slice(0, 3)
        .map((c) => c.context)
        .filter(Boolean)
        .join(', ');
      lines.push(
        `- **${humanDuration(block.activeMs)}** ${clockTime(block.start)}–${clockTime(block.end)} · ${block.label || categoryLabel(block.category, locale)}${contexts ? ` · ${contexts}` : ''}`,
      );
    }
    lines.push('');
  }

  // ---------------------------------------------------------------- journal
  if (journal.length > 0) {
    lines.push(L.journal, '');
    for (const entry of journal.slice(0, 12)) {
      lines.push(`- ${clockTime(entry.start)} — ${entry.text}`);
    }
    lines.push('');
  }

  // ---------------------------------------------------------- observations
  lines.push(L.observe, '');
  for (const observation of observations(stats, locale)) lines.push(`- ${observation}`);
  lines.push('');

  lines.push(L.suggest, '');
  for (const suggestion of suggestions(stats, locale)) lines.push(`- ${suggestion}`);
  lines.push('');

  if (stats.apps.length === 0) lines.push(L.none, '');

  return lines.join('\n');
}

/** Plain-language facts, each one checkable against the tables above. */
export function observations(stats: DayStats, locale: Locale = 'en'): string[] {
  const zh = locale === 'zh';
  const out: string[] = [];
  const top = stats.apps[0];
  if (top && top.foregroundMs > 0) {
    out.push(
      zh
        ? `${top.app} 占据了最多前台时间（${humanDuration(top.foregroundMs)}）。`
        : `${top.app} took the most foreground time (${humanDuration(top.foregroundMs)}).`,
    );
  }

  const worst = [...stats.categories]
    .filter((c) => ['entertainment', 'social', 'shopping'].includes(c.category))
    .sort((a, b) => b.ms - a.ms)[0];
  if (worst && worst.share > 0.08) {
    out.push(
      zh
        ? `分类「${categoryLabel(worst.category, locale)}」占 ${Math.round(worst.share * 100)}%（${humanDuration(worst.ms)}），这不低。`
        : `“${categoryLabel(worst.category, locale)}” accounted for ${Math.round(worst.share * 100)}% (${humanDuration(worst.ms)}), which is not nothing.`,
    );
  }

  const best = stats.categories.find((c) => c.category === 'deep-work');
  if (best && best.ms > 0) {
    out.push(
      zh
        ? `深度工作累计 ${humanDuration(best.ms)}。`
        : `Deep work totalled ${humanDuration(best.ms)}.`,
    );
  }

  if (stats.switches > 0 && stats.activeMs > 0) {
    const perHour = stats.switches / Math.max(stats.activeMs / 3_600_000, 1 / 60);
    out.push(
      zh
        ? `平均每小时切换窗口 ${perHour.toFixed(1)} 次。`
        : `You switched windows about ${perHour.toFixed(1)} times per hour.`,
    );
  }

  if (stats.backgroundMs > stats.activeMs && stats.backgroundMs > 10 * 60_000) {
    out.push(
      zh
        ? `后台工作时间（${humanDuration(stats.backgroundMs)}）超过了前台，说明这段时间机器在替你干活。`
        : `Background work (${humanDuration(stats.backgroundMs)}) exceeded foreground time — the machine was working for you.`,
    );
  }

  if (stats.longestBlockMs >= 25 * 60_000) {
    out.push(
      zh
        ? `最长一段不被打断的专注是 ${humanDuration(stats.longestBlockMs)}。`
        : `Your longest uninterrupted stretch was ${humanDuration(stats.longestBlockMs)}.`,
    );
  } else if (stats.activeMs > 2 * 3_600_000) {
    out.push(
      zh
        ? `没有出现超过 25 分钟的连续专注段——这一天很碎。`
        : `No stretch longer than 25 minutes appeared — the day was fragmented.`,
    );
  }

  return out;
}

/** Concrete, low-effort suggestions tied to what the numbers actually show. */
export function suggestions(stats: DayStats, locale: Locale = 'en'): string[] {
  const zh = locale === 'zh';
  const out: string[] = [];

  if (stats.longestBlockMs < 25 * 60_000 && stats.activeMs > 2 * 3_600_000) {
    out.push(
      zh
        ? '明天试一次 25 分钟专注块：把聊天软件通知关掉，只留一个窗口。'
        : 'Try one 25-minute focus block tomorrow: silence chat notifications and keep a single window open.',
    );
  }

  const fragment = stats.focus.factors.find((f) => f.id === 'fragmentation');
  if (fragment && fragment.value < 55) {
    out.push(
      zh
        ? '切换太频繁是当前最大的失分项；把「查一下」记在待办里而不是立刻切过去，能明显改善。'
        : 'Switching is your biggest score loss; writing “look this up” as a task instead of switching immediately helps a lot.',
    );
  }

  const topDistraction = [...stats.apps]
    .filter((a) => ['entertainment', 'social', 'shopping'].includes(a.category))
    .sort((a, b) => b.foregroundMs - a.foregroundMs)[0];
  if (topDistraction && topDistraction.foregroundMs > 20 * 60_000) {
    out.push(
      zh
        ? `给 ${topDistraction.app} 设一个时间盒（比如 20 分钟），比强迫自己完全不碰更现实。`
        : `Give ${topDistraction.app} a time box (say 20 minutes) rather than trying to avoid it entirely.`,
    );
  }

  const background = [...stats.apps].sort((a, b) => b.backgroundMs - a.backgroundMs)[0];
  if (background && background.backgroundMs > 30 * 60_000) {
    out.push(
      zh
        ? `${background.app} 在后台占了 ${humanDuration(background.backgroundMs)}；如果那不是在为你干活，考虑关掉它。`
        : `${background.app} spent ${humanDuration(background.backgroundMs)} in the background; if it was not working for you, consider closing it.`,
    );
  }

  if (out.length === 0) {
    out.push(
      zh ? '这一天没有明显问题，保持即可。' : 'Nothing obviously wrong with this day. Keep doing it.',
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Redaction: what may leave the machine
// ---------------------------------------------------------------------------

export interface RedactionOptions {
  level: RedactionLevel;
  locale?: Locale;
  /** Include the user's own journal text verbatim (they wrote it to be read). */
  includeJournal?: boolean;
  maxApps?: number;
}

/**
 * Build the payload an LLM would receive.
 *
 * This is also what the UI previews, so it must be honest about its own contents:
 * every field here is something the user can see before it is sent.
 */
export function buildRedactedPayload(
  stats: DayStats,
  journal: readonly JournalEntry[],
  options: RedactionOptions,
): Record<string, unknown> {
  const { level } = options;
  const maxApps = options.maxApps ?? 12;

  const accounts = {
    engagedMs: stats.activeMs,
    backgroundMs: stats.backgroundMs,
    awayMs: stats.idleMs,
    cpuMs: stats.cpuMs,
    switches: stats.switches,
    spanMs: stats.spanMs,
  };

  const categories = stats.categories.map((c) => ({
    category: c.category,
    minutes: Math.round(c.ms / 60_000),
    share: Number(c.share.toFixed(3)),
  }));

  const apps = stats.apps.slice(0, maxApps).map((app) => {
    const base = {
      app: app.app,
      category: app.category,
      foregroundMinutes: Math.round(app.foregroundMs / 60_000),
      backgroundMinutes: Math.round(app.backgroundMs / 60_000),
      cpuMinutes: Math.round(app.cpuMs / 60_000),
      switches: app.switches,
    };
    if (level === 'app') return base;
    // `context` and `full` add where the time actually went inside the app.
    return {
      ...base,
      contexts: app.contexts
        .slice(0, 5)
        .map((c) => ({ context: c.context, minutes: Math.round(c.ms / 60_000) })),
    };
  });

  const hours = stats.hours.map((h) => ({
    hour: h.hour,
    activeMinutes: Math.round(h.activeMs / 60_000),
    topApp: level === 'app' ? undefined : h.topApp,
  }));

  const focus = {
    score: stats.focus.score,
    grade: stats.focus.grade,
    confidence: Number(stats.focus.confidence.toFixed(2)),
    factors: stats.focus.factors.map((f) => ({ id: f.id, value: Number(f.value.toFixed(3)), weight: f.weight })),
    notes: stats.focus.notes,
  };

  const payload: Record<string, unknown> = {
    day: stats.day,
    redactionLevel: level,
    accounts,
    categories,
    apps,
    hours,
    focus,
    longestBlockMinutes: Math.round(stats.longestBlockMs / 60_000),
    blocks: stats.blocks.slice(0, 8).map((b) => ({
      start: new Date(b.start).toISOString(),
      end: new Date(b.end).toISOString(),
      activeMinutes: Math.round(b.activeMs / 60_000),
      category: b.category,
      label: b.label,
      apps: b.apps.slice(0, 5),
      ...(level === 'app' ? {} : { contexts: b.contexts.slice(0, 5).map((c) => c.context) }),
    })),
  };

  if (options.includeJournal !== false && journal.length > 0) {
    payload['journal'] = journal.slice(0, 20).map((entry) => ({
      at: new Date(entry.start).toISOString(),
      text: entry.text,
    }));
  }

  return payload;
}

/** System/user prompts for the LLM report. Kept here so they are reviewable. */
export function reportPrompts(stats: DayStats, locale: Locale, instruction?: string): {
  system: string;
  user: string;
} {
  const zh = locale === 'zh';
  const system = zh
    ? [
        '你是一个严格、务实的个人效率分析师。',
        '你会收到一份脱敏后的活动统计数据，不会看到原始窗口标题。',
        '请用中文写一份诊断书，包含：1) 这一天的真实状态（不要吹捧也不要指责）；2) 三个最具体的问题，每个都要引用数据；3) 两到三条明天就能执行的具体建议。',
        '要求：只使用给出的数据，不要编造；不要复述所有数字；总长度控制在 400 字以内；不要使用空洞的激励语。',
      ].join('\n')
    : [
        'You are a rigorous, practical personal-effectiveness analyst.',
        'You receive redacted activity statistics — never raw window titles.',
        'Write a diagnosis containing: (1) an honest read of the day, neither flattering nor scolding; (2) the three most specific problems, each citing a number; (3) two or three concrete things to try tomorrow.',
        'Rules: use only the supplied data, never invent numbers; do not restate every figure; keep it under 400 words; no empty motivational language.',
      ].join('\n');

  const user = [
    instruction ? `Extra instruction from the user: ${instruction}` : '',
    '',
    'Statistics:',
    JSON.stringify(buildRedactedPayload(stats, [], { level: 'context', locale }), null, 2),
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

/** Total observed span, useful for sanity-checking a report. */
export function observedSpan(stats: DayStats): number {
  return Math.max(0, stats.lastSeen - stats.firstSeen);
}

export function segmentMinutes(segment: ActivitySegment): number {
  return Math.max(0, segment.end - segment.start) / 60_000;
}
