# Roadmap

Ordered by what makes the tool more useful to the person already using it, not by
what is most fun to build. Each item says what "done" means, because a roadmap
without acceptance criteria is a wish list.

State as of v0.1.0: Windows sensing, minute accounting, classification, focus
scoring, SQLite, the HTTP API, the CLI, the dashboard and the desktop pet all
work on a live machine. 43 tests, 52 render checks, 26 serving checks.

---

## Next

### 1. The configurable day boundary — **done**

`tracking.dayStartHour` (default 4) is in the config and in `PublicSettings`,
`dayBounds()` and `todayKey()` in `packages/daemon/src/analytics.ts` apply it,
the CLI's day defaults and the dashboard's `toDayKey` both derive the current day
through it, and the Settings screen has the picker. A 01:30 session now appears in
the evening it started.

Storage was deliberately untouched: rollups are keyed by minute and have no day
column, so the boundary is purely a query concern.

**The bug this surfaced.** `logicalDayBounds` computed its end as `start + 24h`.
That is wrong twice a year in any zone with daylight saving: on the spring-forward
date 04:00 plus 24 real hours is 05:00, and on the fall-back date it is 03:00. The
first **double-counts** 04:00-05:00 into both days; the second **loses** an hour
from every day. Both are invisible in a zone without DST, which is where the tests
were written. It now builds boundaries from wall-clock components, and the tests
switch `process.env.TZ` to America/New_York to prove a day is 23, 24 or 25 hours
as the calendar requires while adjacent days still tile exactly once.

Worth remembering: the original comment said these helpers were "kept and tested
because the arithmetic is easy to get wrong". It was wrong, in a way the tests
could not see, until they were run in a timezone that has the problem.

### 2. Task reminders that actually reach the user — **done**

The daemon checks `db.dueReminders()` every 30 seconds with a
configurable lead (`tracking.reminderLeadMin`, default 5), emits `reminder` over
SSE, the CLI prints it, the dashboard shows an in-page reminder stack plus a
system notification when permitted, and `ai.dailyReportHour` writes one report a
day — locally by default, or through the model when `ai.autoReports` is on.

Remaining work: a reminder for a task with no due date, and per-task lead times.

### 3. Voice input — **done**

The dashboard has a microphone button next to the task field. It uses the
browser's `SpeechRecognition` API, appends the transcript to the same draft the
keyboard writes to, and therefore goes through the identical `taskparse.ts` path
and parse preview. The button is not rendered where the API is missing (Firefox),
and the fact that Chromium streams the audio to the browser vendor is disclosed
in the UI on first use and documented in
[PRIVACY.md](PRIVACY.md#voice-input).

Remaining work here, if it ever matters: on-device recognition, which would mean
bundling a model. That is a multi-megabyte download inside a bundle that is
currently 60 kB, and it would be worse at Chinese than the cloud service. Not
worth it unless someone asks.

### 3b. Linux and macOS, honestly scoped

Both collectors are implemented and their parsing is now unit-tested (21 tests,
runnable anywhere). What is *not* true is that they have been exercised on real
machines, and the status table in the README says exactly that rather than
implying otherwise.

**Done when:** the collectors run in CI on `ubuntu-latest` and `macos-latest`
against a headless session, asserting that they start, report a coherent
`CollectorStatus`, and return samples whose shape satisfies the engine's
invariants. That does not prove the numbers are right on a real desktop, but it
does catch the failure mode that actually happens — an import that throws, a
subprocess that no longer exists, a field that moved.

**Known hard part, unchanged:** Wayland has no portable way to ask which window is
focused. The collector reports `degraded` with that reason rather than recording
nothing, which is the honest outcome until a compositor-specific protocol is used.

### 4. Android companion (usage + tasks)

**Why.** A phone is where a large share of attention goes, and the whole
positioning is the *cross-device* timeline. Without it, "your day" has a hole in
it exactly where the user was most distracted.

**Done when:** a Kotlin app reads `UsageStatsManager` foreground events and
`NetworkStatsManager` for context, rolls them up to minutes locally, and syncs
rollups (never raw events) to the daemon over the existing pairing flow. Android
is the target because `UsageStatsManager` is a documented public API.

**Not planned for now:** iOS. There is no supported API for continuous foreground
app tracking; the closest is Screen Time via a DeviceActivity extension, which
requires a paid developer account, gives coarse buckets only, and cannot report
which app was in front. Claiming iOS support would mean claiming something the
platform does not allow.

### 5. HarmonyOS / OpenHarmony agent

**Why.** The user who prompted this project is on HarmonyOS, where ArkTS plus
`@ohos.app.ability` can observe ability lifecycle transitions without a special
permission.

**Done when:** an ArkTS module reports foreground ability transitions as minute
rollups to the same endpoint, reusing the Android sync contract.

---

## Later

### Explain *why* a category is what it is, from the timeline

`classify()` already returns the winning rule id, and `matches()` can explain a
whole decision. Surface it: clicking a timeline row should show which rule fired
and what it matched on. The data is there; only the UI is missing.

### A rules editor that grows the taxonomy from real machines

`attentio doctor` already prints every unclassified app with a paste-ready
`rules` snippet. The next step is a UI that takes that snippet, validates it
against the id grammar the tests enforce, and writes it to the user's own rules
file — so `unknown` shrinks without anyone editing JSON by hand.

### Per-device and per-project deep dive

The rollup table supports arbitrary grouping, but the UI only groups by app,
category and hour. Grouping by *project* (from the normalised editor context)
would answer "how much of this week went to which course".

### First-class exported report

`renderReportMarkdown` produces a report and `attentio export` dumps JSON. A
scheduled weekly digest written to a file — or a self-contained HTML page with
the charts inline — would make the diagnosis something a person shares.

### Collector for Linux without a build step — **done**

`packages/daemon/src/collector/linux.ts` reads `/proc/<pid>/stat` for CPU,
`/proc/<pid>/statm` for resident memory, and `/proc/<pid>/comm` when the `exe`
symlink is not readable — which, for other users' processes, is the common case
rather than the exception. X11 focus comes from `xprop`/`xdotool`; Wayland is the
hard part and still reports `degraded`.

---

## Explicit non-goals

These are not "not yet". They are decisions, and each has a reason.

- **Keystrokes, clipboard, screenshots, screen recording.** The product is about
  where attention goes, not what was typed. This is also what makes it
  defensible to install on a machine you share with other people. See
  [PRIVACY.md](PRIVACY.md).
- **An account or a cloud service.** Local-first is what lets the report include
  real app names without anyone's server holding them.
- **A productivity score that is not explainable.** Every number the tool shows
  must be traceable to a factor with a weight and a plain-language reason. If a
  score cannot be explained, it will not be trusted, and it should not be.
- **Guessing a category for unknown apps.** `unknown` is a real answer, and the
  `doctor` command exists to turn it into a rule. A taxonomy that grows by
  silent guessing rots.
- **A leaderboard, streak-shaming or gamified guilt.** The tool measures; it does
  not nag. The pet says something useful or nothing.
- **Port-forwarding the dashboard to the internet.** There is no TLS and no
  threat model for it. LAN plus pairing is the supported remote story.

---

## How to judge a proposal

Three questions, in order:

1. Does it make an existing number *more true*, or does it add a number?
2. Can the user see why the tool concluded what it concluded?
3. Would this still be worth building if the AI feature were deleted?

If a proposal fails all three, it is a different product.
