/**
 * Linux and macOS collector parsing.
 *
 * This is the part of those collectors that cannot be exercised on the machine
 * this project is developed on, and it is also the part that fails *quietly*: a
 * collector that cannot read `/proc` produces no samples and the day shows zeros,
 * which someone will notice, whereas a parser that reads the wrong field produces
 * a plausible number for the wrong thing and nothing anywhere complains.
 *
 * Every sample below is the real shape of the output, including the cases that
 * break naive parsing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDelimitedList,
  parseIoregIdleNs,
  parseProcStat,
  parseProcStatm,
  parsePsLine,
  parseXdotoolIds,
  parseXpropActiveWindow,
  parseXpropWindowProps,
  ticksToMs,
  unescapeXpropString,
} from '../src/collector/parse.ts';
import { EMPTY_TITLE_LIMIT, updateTitleAvailability } from '../src/collector/darwin.ts';

// ---------------------------------------------------------------------------
// /proc/<pid>/stat
// ---------------------------------------------------------------------------

/**
 * Build a stat line with the given comm and utime/stime.
 *
 * Fields after comm are space-separated and positional, so the filler here is a
 * count rather than a copy of a real line — what matters is that the field
 * *positions* match the kernel's.
 */
function statLine(pid: number, comm: string, utime: number, stime: number): string {
  // state, ppid, pgrp, session, tty_nr, tpgid, flags, minflt, cminflt, majflt,
  // cmajflt, utime, stime, ...
  const after = [
    'S', // state
    '1', // ppid
    '100', // pgrp
    '100', // session
    '0', // tty_nr
    '100', // tpgid
    '4194304', // flags
    '1234', // minflt
    '56', // cminflt
    '0', // majflt
    '0', // cmajflt
    String(utime),
    String(stime),
    '0', // cutime
    '0', // cstime
    '20', // priority
    '0', // nice
    '1', // num_threads
    '0', // itrealvalue
    '1234567', // starttime
    '1000000', // vsize
    '4096', // rss
  ];
  return `${pid} (${comm}) ${after.join(' ')}`;
}

test('a plain stat line yields its cpu ticks', () => {
  const parsed = parseProcStat(statLine(4242, 'bash', 150, 50));
  assert.ok(parsed);
  assert.equal(parsed.comm, 'bash');
  assert.equal(parsed.state, 'S');
  assert.equal(parsed.ppid, 1);
  assert.equal(parsed.cpuTicks, 200);
});

test('cpu ticks convert to milliseconds at USER_HZ', () => {
  // 100 ticks is one second of CPU at USER_HZ=100.
  assert.equal(ticksToMs(100), 1000);
  assert.equal(ticksToMs(0), 0);
  assert.equal(ticksToMs(250), 2500);
});

test('a comm containing spaces does not misalign the fields', () => {
  // A process can rename itself, and the kernel does not stop it using spaces. This
  // is the case that breaks a naive `split(' ')`.
  const parsed = parseProcStat(statLine(7, 'my long app name', 30, 70));
  assert.ok(parsed);
  assert.equal(parsed.comm, 'my long app name');
  assert.equal(parsed.cpuTicks, 100, 'utime and stime must still be read from the right fields');
});

test('a comm containing parentheses does not misalign the fields', () => {
  // `(sd-pam)`, `(node)`, and anything a program decides to call itself.
  const parsed = parseProcStat(statLine(9, 'weird (name) here', 11, 22));
  assert.ok(parsed);
  assert.equal(parsed.comm, 'weird (name) here');
  assert.equal(parsed.cpuTicks, 33);
});

test('a comm that is itself a closing parenthesis is handled', () => {
  // The parser finds the *last* ')', so a comm ending in ')' is the adversarial
  // case for it.
  const parsed = parseProcStat(statLine(11, ')', 5, 5));
  assert.ok(parsed);
  assert.equal(parsed.cpuTicks, 10);
});

test('a truncated stat line is rejected rather than read as zeros', () => {
  // Returning 0 here would look like an idle process; null is honest.
  assert.equal(parseProcStat('1234 (bash) S 1'), null);
  assert.equal(parseProcStat('nonsense'), null);
  assert.equal(parseProcStat(''), null);
});

test('statm reports resident memory, not address space', () => {
  // Field 0 is the address space, which on a browser is tens of GB and would be a
  // wild over-count. Field 1 is resident, in pages.
  assert.equal(parseProcStatm('1234567 4096 512 1 0 8192 0'), 4096 * 4096);
  assert.equal(parseProcStatm('100 1 1 0 0 1 0'), 4096);
  assert.equal(parseProcStatm('garbage'), 0);
  assert.equal(parseProcStatm(''), 0);
});

// ---------------------------------------------------------------------------
// X11
// ---------------------------------------------------------------------------

test('the active window id is read from xprop, and absence is not window 0x0', () => {
  assert.equal(
    parseXpropActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3e00007\n'),
    '0x3e00007',
  );
  // xprop prints a sentence when nothing is focused. A naive hex match on '0' would
  // invent a window here.
  assert.equal(parseXpropActiveWindow('_NET_ACTIVE_WINDOW:  no such atom on any window.\n'), '');
  assert.equal(parseXpropActiveWindow(''), '');
});

test('window properties yield the title and pid', () => {
  const props = [
    '_NET_WM_NAME(UTF8_STRING) = "attentio — README.md - Visual Studio Code"',
    '_NET_WM_PID(CARDINAL) = 20712',
    '',
  ].join('\n');
  const parsed = parseXpropWindowProps(props);
  assert.equal(parsed.title, 'attentio — README.md - Visual Studio Code');
  assert.equal(parsed.pid, 20712);
});

test('a window title containing a quote is not truncated or left escaped', () => {
  // A file named notes"final.txt" is a legal filename and a legal window title.
  // xprop escapes each inner quote as \", and the escape must be *removed*: storing
  // it verbatim shows the user backslashes that are not in their filename.
  const parsed = parseXpropWindowProps('_NET_WM_NAME(UTF8_STRING) = "notes\\"final.txt\\" - vim"\n');
  assert.equal(parsed.title, 'notes"final.txt" - vim');
});

test('xprop escaping is undone in one pass, not two replacements', () => {
  // A literal backslash is \\ and a literal quote is \", so a backslash directly
  // before a quote is \\\" — two independent replacements get this wrong.
  assert.equal(unescapeXpropString('a\\\\b'), 'a\\b');
  assert.equal(unescapeXpropString('a\\"b'), 'a"b');
  assert.equal(unescapeXpropString('a\\\\\\"b'), 'a\\"b');
  // An unknown escape is left alone rather than swallowing the character.
  assert.equal(unescapeXpropString('a\\nb'), 'a\\nb');
  assert.equal(unescapeXpropString('plain'), 'plain');
  assert.equal(unescapeXpropString(''), '');
  // A trailing lone backslash must not be dropped.
  assert.equal(unescapeXpropString('end\\'), 'end\\');
});

test('a window with no pid still yields its title', () => {
  const parsed = parseXpropWindowProps('_NET_WM_NAME(UTF8_STRING) = "Desktop"\n');
  assert.equal(parsed.title, 'Desktop');
  assert.equal(parsed.pid, 0);
});

test('missing window properties do not throw', () => {
  assert.deepEqual(parseXpropWindowProps(''), { title: '', pid: 0 });
  assert.deepEqual(parseXpropWindowProps('xprop: error: no such window'), { title: '', pid: 0 });
});

test('xdotool window ids are decimal and one per line', () => {
  assert.deepEqual(parseXdotoolIds('35651588\n35651590\n'), ['35651588', '35651590']);
  assert.deepEqual(parseXdotoolIds(''), []);
  // xdotool prints a warning to stdout in some versions; it must be ignored
  // rather than turning into a bogus window id.
  assert.deepEqual(parseXdotoolIds('WARNING: something\n123\n'), ['123']);
});

// ---------------------------------------------------------------------------
// macOS: is a missing window title evidence of a permission problem?
// ---------------------------------------------------------------------------

test('one empty window title does not mean titles are unreadable', () => {
  // The case the old rule got wrong. The frontmost application is the desktop or
  // Finder a good deal of the time, and both report no title.
  const decided = updateTitleAvailability(0, '');
  assert.equal(decided.titlesAvailable, true, 'a single empty title is normal');
  assert.equal(decided.streak, 1);
});

test('a run of empty titles eventually concludes titles are unreadable', () => {
  // A real Accessibility failure is not intermittent: every sample has no title.
  let streak = 0;
  let available = true;
  for (let i = 1; i < EMPTY_TITLE_LIMIT; i++) {
    const decided = updateTitleAvailability(streak, '');
    streak = decided.streak;
    available = decided.titlesAvailable;
    assert.equal(available, true, `still optimistic after ${i} empty titles`);
  }
  const final = updateTitleAvailability(streak, '');
  assert.equal(final.titlesAvailable, false, `degrades at ${EMPTY_TITLE_LIMIT} consecutive`);
});

test('a title arriving resets the streak, so a transient is not cumulative', () => {
  // Switching Spaces, then back to a real window, must not add up to a false
  // conclusion over an afternoon.
  let streak = 0;
  for (let round = 0; round < 20; round++) {
    streak = updateTitleAvailability(streak, '').streak;
    streak = updateTitleAvailability(streak, 'README.md - Code').streak;
    assert.equal(streak, 0);
  }
  assert.equal(updateTitleAvailability(streak, 'README.md - Code').titlesAvailable, true);
});

test('recovery is immediate once a title can be read again', () => {
  // The old rule never reconsidered within a session, so one empty title meant
  // "degraded" for the rest of the day.
  let streak = 0;
  for (let i = 0; i < EMPTY_TITLE_LIMIT; i++) streak = updateTitleAvailability(streak, '').streak;
  assert.equal(updateTitleAvailability(streak, '').titlesAvailable, false);
  const recovered = updateTitleAvailability(streak, 'Inbox - Mail');
  assert.equal(recovered.titlesAvailable, true);
  assert.equal(recovered.streak, 0);
});

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

test('a ps row with a path in comm is parsed', () => {
  const row = parsePsLine('  501   2.3  45678 /Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  assert.ok(row);
  assert.equal(row.pid, 501);
  assert.equal(row.cpuPct, 2.3);
  assert.equal(row.memBytes, 45678 * 1024);
  assert.equal(row.command, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
});

test('a ps row whose comm contains spaces keeps the whole name', () => {
  // `comm` is the last column and is not a single token on Linux, where it is the
  // full command line in some ps builds.
  const row = parsePsLine('  19   0.0   1234 Visual Studio Code Helper');
  assert.ok(row);
  assert.equal(row.command, 'Visual Studio Code Helper');
});

test('a ps row with an integer percentage is parsed', () => {
  const row = parsePsLine('  7  100  2048 chrome');
  assert.ok(row);
  assert.equal(row.cpuPct, 100);
  assert.equal(row.memBytes, 2048 * 1024);
});

test('ps header lines and malformed rows are rejected', () => {
  assert.equal(parsePsLine('  PID %CPU    RSS COMM'), null);
  assert.equal(parsePsLine(''), null);
  assert.equal(parsePsLine('  0   0.0   0 nothing'), null, 'pid 0 is not a process we track');
  // A whitespace-only tail is truthy in JavaScript, so this row used to produce a
  // process with no name.
  assert.equal(parsePsLine('  12   0.0   100   '), null, 'a row with no command is unusable');
});

test('the ioreg idle counter is nanoseconds', () => {
  const output = '    "HIDIdleTime" = 30000000000\n';
  assert.equal(parseIoregIdleNs(output), 30_000_000_000);
  // Absence means "no reading", not "idle".
  assert.equal(parseIoregIdleNs(''), 0);
  assert.equal(parseIoregIdleNs('    "HIDIdleTime" = 0\n'), 0);
});

test('an application name containing a comma survives the round trip', () => {
  // The previous implementation split the AppleScript result on ',' and returned a
  // list, which turned one such app into two invented ones and truncated both.
  const DELIM = '\u001f';
  const apps = ['Safari', 'Foo, Inc.', 'Visual Studio Code'];
  const raw = apps.map((a) => a + DELIM).join('');
  assert.deepEqual(parseDelimitedList(raw), apps);
});

test('the osascript list tolerates an empty result', () => {
  assert.deepEqual(parseDelimitedList(''), []);
  assert.deepEqual(parseDelimitedList('\u001f\u001f'), []);
  assert.deepEqual(parseDelimitedList('\n  Safari  \u001f'), ['Safari']);
});
