# Roadmap

Ordered by what makes the tool more useful to the person already using it, not by
what is most fun to build. Each item says what "done" means, because a roadmap
without acceptance criteria is a wish list.

State as of v0.1.0: Windows sensing, minute accounting, classification, focus
scoring, SQLite, the HTTP API, the CLI, the dashboard and the desktop pet all
work on a live machine. 43 tests, 52 render checks, 26 serving checks.

---

## Next

### 1. The 4am day boundary

**Why.** A student's 01:30 session should appear in *that* evening's log, not
tomorrow's. Every sleep-aware tracker converges on this and it is the difference
between an honest "what did I do yesterday" and one that splits a night in half.

**What exists.** `logicalDayKey()` and `logicalDayBounds()` in
`packages/shared/src/time.ts` are implemented and tested, but deliberately wired
into nothing. The daemon slices days at local midnight (`dayBounds()` in
`packages/daemon/src/analytics.ts`), and both clients follow it.

**Done when:**
- `tracking.dayStartHour` (default 4) exists in the config and in `PublicSettings`;
- `dayBounds()` and `todayKey()` take it and use `logicalDayBounds`/`logicalDayKey`;
- the CLI, the server's default `day`, and the dashboard's `toDayKey` all derive
  the current day through that one path;
- a test asserts that a 01:30 sample lands in the previous day's totals and that
  `computeTrend` labels its points consistently;
- the day picker shows the boundary, so "today" is not silently the wrong window.

**Trap to avoid.** Do not change the storage layer; rollups are keyed by minute
and have no day column. The boundary is a *query* concern.

### 2. Task reminders that actually reach the user

**Why.** The schema, the API and the `reminder` SSE event exist; nothing fires
them on a schedule.

**Done.** The daemon checks `db.dueReminders()` every 30 seconds with a
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

### Collector for Linux without a build step

A `/proc`-based collector needs no native code: `/proc/<pid>/stat` for CPU,
`/proc/<pid>/status` for memory, and `/proc/<pid>/comm` plus the X11 or Wayland
focus API for the foreground window. Wayland is the hard part; X11 is easy.
`packages/daemon/src/collector/linux.ts` has the shape of it.

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
