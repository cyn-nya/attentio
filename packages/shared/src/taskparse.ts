/**
 * Natural-language task input.
 *
 * Shared by the dashboard and the CLI so that "finish the report tomorrow 6pm
 * !high #attentio" means exactly the same thing wherever it is typed. The parser
 * is deliberately conservative: anything it does not recognise stays in the
 * title rather than being silently swallowed, because a task that quietly lost
 * half its words is worse than one with a stray token in it.
 */

import type { TaskPriority } from './types.ts';

export interface ParsedTask {
  title: string;
  priority: TaskPriority;
  dueAt: number | null;
  tags: string[];
  estimateMin: number | null;
  /** What the parser consumed, so the UI can show its work. */
  recognised: string[];
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, 周日: 0, 周天: 0, 星期日: 0,
  monday: 1, mon: 1, 周一: 1, 星期一: 1,
  tuesday: 2, tue: 2, tues: 2, 周二: 2, 星期二: 2,
  wednesday: 3, wed: 3, 周三: 3, 星期三: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, 周四: 4, 星期四: 4,
  friday: 5, fri: 5, 周五: 5, 星期五: 5,
  saturday: 6, sat: 6, 周六: 6, 星期六: 6,
};

function atHour(base: Date, hour: number, minute: number): number {
  const date = new Date(base);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

/** Parse a clock like `18:30`, `6pm`, `9am`, `晚上8点`. */
function parseClock(token: string, base: Date): number | null {
  const colon = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (colon) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour > 23 || minute > 59) return null;
    return atHour(base, hour, minute);
  }

  const meridiem = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/i.exec(token);
  if (meridiem) {
    let hour = Number(meridiem[1]) % 12;
    if ((meridiem[3] ?? '').toLowerCase() === 'pm') hour += 12;
    return atHour(base, hour, Number(meridiem[2] ?? 0));
  }

  const cn = /^(\d{1,2})点(?:(\d{1,2})分)?$/.exec(token);
  if (cn) {
    let hour = Number(cn[1]);
    // 1-6 点 with no other hint almost always means the afternoon in practice,
    // but guessing is worse than being literal, so we stay literal.
    if (hour > 23) return null;
    return atHour(base, hour, Number(cn[2] ?? 0));
  }

  return null;
}

export function parseTaskInput(input: string, now = Date.now()): ParsedTask {
  const recognised: string[] = [];
  const tags: string[] = [];
  let priority: TaskPriority = 'normal';
  let dueAt: number | null = null;
  let estimateMin: number | null = null;
  let hasDueDate = false;

  const base = new Date(now);
  const tokens = input.split(/\s+/).filter(Boolean);
  const kept: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    const lower = token.toLowerCase();

    // --- tags: #attentio, #写作 -------------------------------------------
    const tagMatch = /^#([^\s#]+)$/.exec(token);
    if (tagMatch) {
      tags.push((tagMatch[1] as string).toLowerCase());
      recognised.push(token);
      continue;
    }

    // --- priority: !high !h !1 !!! p1 ------------------------------------
    const bangMatch = /^!+(high|med|medium|low|h|m|l)?$/.exec(lower);
    if (bangMatch) {
      const level = bangMatch[1];
      priority = level?.startsWith('h') || level === undefined ? 'high' : level.startsWith('l') ? 'low' : 'normal';
      recognised.push(token);
      continue;
    }
    const pMatch = /^p([123])$/.exec(lower);
    if (pMatch) {
      priority = pMatch[1] === '1' ? 'high' : pMatch[1] === '3' ? 'low' : 'normal';
      recognised.push(token);
      continue;
    }

    // --- estimate: ~30m ~2h ---------------------------------------------
    const estMatch = /^~(\d+)(m|h)?$/.exec(lower);
    if (estMatch) {
      const amount = Number(estMatch[1]);
      estimateMin = (estMatch[2] ?? 'm') === 'h' ? amount * 60 : amount;
      recognised.push(token);
      continue;
    }

    // --- relative due: +2h +30m in 2h -----------------------------------
    const plusMatch = /^\+(\d+)(m|h|d)$/.exec(lower);
    if (plusMatch) {
      const factor = plusMatch[2] === 'm' ? 60_000 : plusMatch[2] === 'h' ? 3_600_000 : 86_400_000;
      dueAt = now + Number(plusMatch[1]) * factor;
      hasDueDate = true;
      recognised.push(token);
      continue;
    }
    if ((lower === 'in' || lower === 'in:') && index + 1 < tokens.length) {
      const next = (tokens[index + 1] as string).toLowerCase();
      const relative = /^(\d+)(m|h|d)$/.exec(next);
      if (relative) {
        const factor = relative[2] === 'm' ? 60_000 : relative[2] === 'h' ? 3_600_000 : 86_400_000;
        dueAt = now + Number(relative[1]) * factor;
        hasDueDate = true;
        recognised.push(token, tokens[index + 1] as string);
        index++;
        continue;
      }
    }

    // --- absolute date: 2026-11-01, 11/01 --------------------------------
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
      const parsed = Date.parse(`${token}T09:00:00`);
      if (Number.isFinite(parsed)) {
        dueAt = parsed;
        hasDueDate = true;
        recognised.push(token);
        continue;
      }
    }
    const slashDate = /^(\d{1,2})\/(\d{1,2})$/.exec(token);
    if (slashDate) {
      const date = new Date(base);
      date.setMonth(Number(slashDate[1]) - 1, Number(slashDate[2]));
      dueAt = atHour(date, 9, 0);
      hasDueDate = true;
      recognised.push(token);
      continue;
    }

    // --- day words: today / tomorrow / tonight / 明天 / 今晚 --------------
    const dayWords: Record<string, { offset: number; hour?: number }> = {
      today: { offset: 0 }, 今天: { offset: 0 },
      tonight: { offset: 0, hour: 20 }, 今晚: { offset: 0, hour: 20 },
      tomorrow: { offset: 1 }, tmr: { offset: 1 }, tmrw: { offset: 1 }, 明天: { offset: 1 },
      '明天晚上': { offset: 1, hour: 20 },
      '后天': { offset: 2 },
      'this weekend': { offset: 0 },
    };
    if (lower in dayWords) {
      const spec = dayWords[lower] as { offset: number; hour?: number };
      const date = new Date(base);
      date.setDate(date.getDate() + spec.offset);
      dueAt = spec.hour !== undefined ? atHour(date, spec.hour, 0) : atHour(date, 23, 59);
      hasDueDate = true;
      recognised.push(token);
      continue;
    }

    // --- weekday: fri / 周五 / next monday ------------------------------
    const maybeNext = lower === 'next' && index + 1 < tokens.length;
    const weekdayToken = maybeNext ? (tokens[index + 1] as string).toLowerCase() : lower;
    if (weekdayToken in WEEKDAYS) {
      const target = WEEKDAYS[weekdayToken] as number;
      const date = new Date(base);
      let delta = (target - date.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      if (maybeNext) delta += 7;
      date.setDate(date.getDate() + delta);
      dueAt = atHour(date, 9, 0);
      hasDueDate = true;
      recognised.push(token);
      if (maybeNext) {
        recognised.push(tokens[index + 1] as string);
        index++;
      }
      continue;
    }

    // --- clock: 18:30 / 6pm ---------------------------------------------
    if (!dueAt) {
      const clock = parseClock(lower, base);
      if (clock !== null) {
        // A bare time earlier today means tomorrow, not the past.
        dueAt = clock < now ? clock + 86_400_000 : clock;
        hasDueDate = true;
        recognised.push(token);
        continue;
      }
    }

    kept.push(token);
  }

  // An explicit due *date* with no time lands at end of day; a due *time* today
  // that has already passed rolls forward. Both are handled above.
  void hasDueDate;

  const title = kept.join(' ').trim() || input.trim();
  return { title, priority, dueAt, tags, estimateMin, recognised };
}

/** Render a recognised task back to text, used for the "did you mean" preview. */
export function describeParsedTask(parsed: ParsedTask, locale: 'en' | 'zh' = 'en'): string {
  const parts: string[] = [];
  const zh = locale === 'zh';
  if (parsed.dueAt) {
    const date = new Date(parsed.dueAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    parts.push(
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    );
  }
  if (parsed.priority !== 'normal') parts.push(zh ? `优先级 ${parsed.priority}` : `priority ${parsed.priority}`);
  if (parsed.estimateMin) parts.push(`~${parsed.estimateMin}m`);
  if (parsed.tags.length > 0) parts.push(parsed.tags.map((tag) => `#${tag}`).join(' '));
  return parts.join(' · ');
}
