/**
 * Parsers for the Linux and macOS collectors.
 *
 * These are separated from the collectors for one reason: they are the part that
 * is *wrong silently*. A collector that fails to read `/proc` returns no samples
 * and the day shows zeros, which is at least visible. A parser that reads the
 * wrong field returns a plausible number for the wrong thing, and nothing
 * anywhere will complain.
 *
 * They are also the only part of those collectors that can be tested on a machine
 * that is neither Linux nor macOS, which is where this project is developed. Every
 * function here takes text and returns data — no filesystem, no subprocess — so
 * the tests can feed it real captured output.
 */

/** `USER_HZ`. 100 on every mainstream Linux build and on the ones this targets. */
const CLOCK_TICKS = 100;
const PAGE_SIZE = 4096;

export interface ProcStat {
  /** The `comm` field, which is the executable *name*, not its path. */
  comm: string;
  state: string;
  ppid: number;
  /** Cumulative CPU time in clock ticks, user + system. */
  cpuTicks: number;
}

/**
 * Parse `/proc/<pid>/stat`.
 *
 * The format is 52 space-separated fields starting at the pid, but field 2 is
 * `comm` wrapped in parentheses and it **may contain spaces and parentheses** — a
 * process can rename itself to `(my app)`. Splitting the whole line on spaces
 * therefore misaligns every field after it, which is the classic way this parser
 * is written wrong. Everything after the *last* `)` is safe, because a `)` inside
 * comm can only appear before the final one.
 */
export function parseProcStat(text: string): ProcStat | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const open = text.indexOf('(');
  if (open < 0 || open > close) return null;

  const comm = text.slice(open + 1, close);
  const fields = text.slice(close + 1).trim().split(/\s+/);
  // fields[0] is the state, which is field 3 of the file. So file field N is at
  // fields[N - 3]: utime is 14, stime is 15, ppid is 4.
  const state = fields[0] ?? '';
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;

  return {
    comm: comm.trim(),
    state,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    cpuTicks: utime + stime,
  };
}

/** Cumulative CPU milliseconds from stat ticks. */
export function ticksToMs(ticks: number): number {
  return (ticks / CLOCK_TICKS) * 1000;
}

/**
 * Resident memory in bytes from `/proc/<pid>/statm`.
 *
 * The second field is resident pages. The first is the whole address space, which
 * on a modern process is a wild over-count; using it would report a browser as
 * using 40 GB.
 */
export function parseProcStatm(text: string): number {
  const fields = text.trim().split(/\s+/);
  const residentPages = Number(fields[1]);
  if (!Number.isFinite(residentPages) || residentPages < 0) return 0;
  return residentPages * PAGE_SIZE;
}

/**
 * The active window id from `xprop -root -notype _NET_ACTIVE_WINDOW`.
 *
 * When nothing is focused, xprop prints a sentence rather than a value, so an
 * absent id is normal and must not be mistaken for window `0x0`.
 */
export function parseXpropActiveWindow(text: string): string {
  const match = /window id #\s*(0x[0-9a-f]+)/i.exec(text) ?? /(0x[0-9a-f]+)/i.exec(text);
  return match?.[1] ?? '';
}

/**
 * Undo xprop's string escaping.
 *
 * xprop emits a C-style escaped string: a literal backslash is `\\` and a literal
 * double quote is `\"`. Storing those verbatim means the dashboard shows
 * `notes\"final.txt\"` for a window actually called `notes"final.txt"`, and the
 * title-comparison logic sees extra characters that are not in the title.
 *
 * One pass, left to right: doing two independent replacements gets
 * backslash-before-quote wrong.
 */
export function unescapeXpropString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === '\\' || next === '"') {
        out += next;
        i++;
        continue;
      }
    }
    out += raw[i];
  }
  return out;
}

/**
 * Title and pid from `xprop -id <id> _NET_WM_NAME _NET_WM_PID`.
 *
 * The title is captured up to the last quote on its own line: a window title
 * genuinely can contain a `"` (a file called `notes"final.txt"`), and a
 * non-greedy `(.*)"` would truncate at the first one.
 */
export function parseXpropWindowProps(text: string): { title: string; pid: number } {
  const titleLine = /^\s*_NET_WM_NAME[^=]*=\s*"(.*)"\s*$/m.exec(text);
  const title = unescapeXpropString(titleLine?.[1] ?? '');
  const pidMatch = /_NET_WM_PID[^=]*=\s*(\d+)/.exec(text);
  const pid = pidMatch?.[1] ? Number.parseInt(pidMatch[1], 10) : 0;
  return { title, pid: Number.isFinite(pid) ? pid : 0 };
}

/** Window ids from xprop or xdotool output: one hex id per match. */
export function parseHexIds(text: string): string[] {
  return text.match(/0x[0-9a-f]+/gi) ?? [];
}

/** Window ids from `xdotool search`, one per line. */
export function parseXdotoolIds(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
}

export interface PsRow {
  pid: number;
  cpuPct: number;
  memBytes: number;
  /** The `comm` column: an executable path on macOS, a path or name on Linux. */
  command: string;
}

/**
 * One row of `ps -Ao pid=,pcpu=,rss=,comm=`.
 *
 * `comm` is last and is allowed to contain spaces, so it is captured as the
 * remainder rather than as a single token — `Visual Studio Code Helper` is one
 * process name, not four fields.
 */
export function parsePsLine(line: string): PsRow | null {
  const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const cpuPct = Number(match[2]);
  const rssKb = Number(match[3]);
  // Trimmed, because a whitespace-only tail is truthy: without this a row like
  // `12 0.0 100   ` yielded a process with no name.
  const command = (match[4] ?? '').trim();
  if (!Number.isFinite(pid) || pid <= 0 || !command) return null;
  return {
    pid,
    cpuPct: Number.isFinite(cpuPct) ? cpuPct : 0,
    // `ps` rss is in kilobytes on both Linux and macOS.
    memBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
    command,
  };
}

/**
 * Idle nanoseconds from `ioreg -c IOHIDSystem`.
 *
 * The value is a 64-bit nanosecond counter, which exceeds `Number.MAX_SAFE_INTEGER`
 * only after ~104 days of uptime; for longer than that the reading is approximate
 * and an idle machine may under-report. Accepted: the alternative is BigInt for a
 * number the UI rounds to minutes.
 */
export function parseIoregIdleNs(text: string): number {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text);
  if (!match?.[1]) return 0;
  const ns = Number(match[1]);
  return Number.isFinite(ns) ? ns : 0;
}

/**
 * A newline-separated list from an osascript result.
 *
 * Commas were the original separator, which silently corrupts any application
 * whose name contains one — `ps` output and app names both contain them. AppleScript
 * can return a delimited string, so the delimiters are chosen to be characters an
 * app name cannot contain.
 */
export function parseDelimitedList(text: string, delimiter = '\u001f'): string[] {
  return text
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
