# Architecture

Five processes, one of which matters: the engine is the only writer, and it
stamps every observation with its own clock. Everything else reads what it wrote.
Two invariants fall out of that, and nearly every design decision below is
downstream of one of them.

> **One clock.** Samples carry the timestamp the engine assigned, never the time
> the collector or the database happened to produce.
>
> **One writer.** Only the engine writes activity rows. The HTTP API, the CLI and
> the dashboard all write tasks, journal entries and reports, but none of them
> can create or modify activity. There is no second code path to keep honest.

---

## The shape

```
   Win32 FFI (koffi)                     ┌──────────────┐
   GetForegroundWindow ─┐                │  ~/.attentio │
   GetLastInputInfo     ├─► collector ─► │ attentio.db  │
   per-process CPU/RAM ─┘       │        └──────┬───────┘
                                ▼               │
                          ┌───────────┐         │
                          │  engine   │─────────┘  the only writer
                          └─────┬─────┘
                                │ segments + minute rollups
                                ▼
   ┌─────────────┐        ┌───────────┐        ┌──────────┐
   │  analytics  │◄───────│    db     │───────►│  server  │──► SSE / REST
   └──────┬──────┘        └───────────┘        └────┬─────┘
          │                                          │
          ▼                                          ▼
   ┌─────────────┐                            ┌─────────────┐
   │   report    │──► ai (opt-in, redacted)   │  apps/web   │  PWA
   └──────┬──────┘                            └─────────────┘
          ▼
   ┌─────────────┐
   │     cli     │  the reference client
   └─────────────┘
```

---

## Packages

### `packages/shared` — the domain, with no dependencies

Pure functions and types. It never touches the OS, the filesystem, the network or
the clock (timestamps are passed in). That is what makes it testable without a
machine and reusable by every other package, including the browser bundle.

| File | Responsibility |
|---|---|
| `types.ts` | Every domain type, including the canonical `RedactionLevel` |
| `categories.ts` | The 12-category taxonomy, colours, localised labels, grade blurbs |
| `rules.ts` | The classifier. `classify()` for the answer, `matches()` for the explanation |
| `defaultRules.ts` | 73 built-in rules, weighted toward zh-CN desktop software |
| `titlenorm.ts` | Reduces a raw window title to a project/file/site context |
| `accumulator.ts` | Turns a stream of window samples into segments |
| `focus.ts` | The five-factor focus score |
| `aggregate.ts` | Segments + rollups into `DayStats` (apps, categories, hours, blocks) |
| `time.ts` | Day keys, minute floors, logical-day helpers |
| `taskparse.ts` | Natural-language task input, shared by the CLI and the dashboard |
| `format.ts` | Duration, byte, percentage and clock formatting |
| `api.ts` | The HTTP contract: paths, request and response types, the SSE event union |

**Why the taxonomy is capped at 12.** A classifier with 60 categories is right
about more things and useless in a report: nobody reads a pie chart with 60
slices. Twelve buckets is enough to distinguish deep work from distraction, and
everything unclassifiable lands in `unknown` rather than being guessed at.

### `packages/daemon` — sensing, storage, and the API

| File | Responsibility |
|---|---|
| `collector/win32.ts` | koffi bindings: foreground window, idle time, process CPU/memory, window inventory |
| `collector/index.ts` | Chooses a collector, or a `NullCollector` that says why it cannot |
| `engine.ts` | The sampling loop. Bills every second to exactly one account, writes segments and rollups |
| `db/index.ts` | SQLite via `node:sqlite`. Migrations, prepared statements, `exportAll()` |
| `analytics.ts` | `computeDay`, `computeTimeline`, `computeTrend`, `computeBlocks` |
| `report.ts` | The deterministic narrative, and `buildRedactedPayload` |
| `ai.ts` | One OpenAI-compatible call. Falls back to the local narrative on any failure |
| `server.ts` | REST + SSE + static hosting for the PWA |
| `config.ts` | Config load/save, env overrides, privacy defaults |

### `packages/cli` — the reference client

No argument-parsing dependency; the grammar is small enough that one would cost
more than it saves. `terminal.ts` does colour and CJK-aware width itself, because
a table that misaligns on Chinese app names is a table nobody trusts.

Every feature in the web UI is reachable from here. That keeps the API honest: if
a capability only exists for the dashboard, it will not survive a refactor.

### `apps/web` — the PWA

Preact, one bundle, no chart library. The shapes this app needs (a 24-bar hour
strip, a focus ring, a stacked account bar) are not what a charting library is
good at, and hand-rolled SVG keeps the whole dashboard installable and offline.

State lives in one component because there are only a handful of resources and
they share a single refresh trigger (the SSE stream). A store would be more
machinery than the problem has.

---

## How a second becomes a number

This is the part worth getting right, so it is spelled out.

1. **Sample.** Every 1000 ms the collector returns the foreground window, the
   idle seconds, and a per-process CPU/memory snapshot.
2. **Stamp.** The engine attaches `Date.now()`. A sample that arrives with an
   older timestamp than the last tick is clamped forward, so a clock that jumps
   backwards cannot double-bill time.
3. **Classify.** `classify()` runs the rule set: executable *or* app name must
   match, and a title pattern further narrows it. The winning rule id is stored
   on the segment, so any number can be traced back to the rule that produced it.
4. **Bill.** The elapsed milliseconds since the last tick go to exactly one
   account:
   - **engaged** — a foreground window and input within the idle threshold;
   - **background** — no foreground window but processes are consuming CPU;
   - **away** — no input for longer than the idle threshold;
   - **`@private`** — the app is excluded, so time is counted with no detail.
5. **Flush.** Every 20 s the accumulator's segments are written, and additive
   minute rollups are upserted into `rollups`, keyed `(device, minute, app,
   category)`.

**Sleep gaps are dropped, not billed.** If the machine suspends, that interval is
recorded as `droppedGapMs` and attributed to nothing. A tracker that reports the
eight hours your laptop spent closed as "background work" is not measuring
anything.

**A day is a query, not a column.** Rollups are keyed by `(device, minute, app,
category)` and there is no date column, so "which day is this minute in" is
decided at read time by `dayBounds()`. That is what lets `tracking.dayStartHour`
exist: setting it to 4 makes a day span 04:00 to 04:00, so a session that runs past
midnight stays in the evening it started, and no stored row has to change. It also
means the boundary arithmetic has to be exactly right and mutual — see
`logicalDayBounds`, which builds its edges from wall-clock components so that a
daylight-saving day is 23 or 25 hours and adjacent days still tile once.

**Why rollups are additive.** Each write adds to the existing row rather than
replacing it, so two independent writers of the *same* minute still converge, and
a crash mid-flush cannot lose a minute that was already counted.

---

## Why these choices

**Node 24 and no native build step.** `node:sqlite` and type stripping mean a
fresh clone runs with `npm install && npm start` — no compiler, no Python, no
MSVC. For a tool people install on their own machine, "you need Visual Studio
Build Tools" is where most attempts stop. `koffi` provides FFI without a compiler
by shipping prebuilt binaries.

**SSE, not WebSockets.** The traffic is one-directional push of small JSON
events, and SSE reconnects itself without a client library. A WebSocket would add
a protocol upgrade, a heartbeat and a reconnect implementation to get strictly
less.

**Two clocks are the product.** ActivityWatch and RescueTime answer "which app
was in front". The question this tool exists to answer is what the machine was
doing *while nothing was in front* — the build, the test suite, the download, the
compile. That is what `backgroundMs` and per-process CPU are for, and it is why
the day's three accounts always sum to the span.

**Explainability is structural, not cosmetic.** `classify()` returns a rule id
and `matches()` returns the whole ordered match list, so the UI can explain a
decision instead of asserting it. The focus score reports five weighted factors
with their contributions and a confidence derived from how much data it has. A
score nobody can interrogate is a score nobody uses.

**The AI is optional and last.** `report.ts` produces a complete narrative with
no network at all. `ai.ts` is a rewriter on top of it, and every failure path --
no key, no network, rate limit, bad JSON -- falls back to the local text and says
so. Delete `ai.ts` and nothing else breaks; that is the test for whether an
optional dependency is really optional.

---

## Data model

Six tables that matter:

| Table | Key | Retention |
|---|---|---|
| `segments` | autoincrement | `segmentRetentionDays` (90), pruned by a 6-hourly check |
| `rollups` | `(device_id, minute, app, category)`, `WITHOUT ROWID` | forever |
| `devices` | `id` | forever |
| `tasks` | autoincrement | forever |
| `journal` | autoincrement | forever |
| `reports` | autoincrement | forever |

`segments` is the source of truth for *context* — which project, which page — and
is disposable. `rollups` is the source of truth for *time* and is tiny: a busy
day is a few thousand rows, so a decade fits in a few megabytes.

Privacy exclusions are applied in the engine, **before** storage. That ordering
matters: excluding at display time would leave the real data in the file, where
anyone with a copy of `attentio.db` could read it.

---

## Testing

There is no browser in CI and no screenshot in a terminal, so the tests are
built to stand in for the things that would normally be verified by looking.

| Suite | What it protects |
|---|---|
| `packages/shared/test` | The classifier's semantics, aggregation arithmetic, focus factors, formatters, time boundaries |
| `packages/daemon/test/engine.test.ts` | Minute accounting, against a scripted collector and a fake clock — exact milliseconds, no dependence on the machine |
| `packages/daemon/test/collector.test.ts` | That the live Win32 collector can actually see this machine. Skipped where there is no Windows |
| `packages/daemon/test/static.test.ts` | The hand-written static host: caching rules, SPA fallback, traversal in five encodings, malformed paths |
| `apps/web/smoke/render.tsx` | Renders every view with a realistic synthetic day and asserts what a person would look for |

The render smoke test exists because the alternative was shipping a dashboard
nobody had ever seen render. It catches the failures that matter most in a UI no
one can watch: a crash from a missing field, a chart that silently renders
nothing, a screen that shows zeros because a field was renamed.

---

## Sensing and parsing are separate

Each non-Windows collector is split in two:

* `darwin.ts` / `linux.ts` — run the subprocess or read the file, and talk to the
  rest of the daemon;
* `parse.ts` — turn that text into numbers, with no filesystem and no subprocess.

The split exists because parsing is where these collectors fail **quietly**. A
collector that cannot read `/proc` returns no samples and the day shows zeros, and
someone notices that. A parser that reads the wrong field returns a plausible
number for the wrong thing, and nothing anywhere complains. Extracting it also
makes it the only part of those collectors testable on a machine that is neither
Linux nor macOS, which is where this project is developed: `collector-parse.test.ts`
feeds it real output shapes, including the ones that break naive parsing.

Three bugs found this way, all of which would have shipped:

* **Processes were named `Pid1234`.** `/proc/<pid>/exe` is a symlink and is not
  readable for processes owned by other users — on a normal desktop, most of them.
  With no exe path the app hint fell back to the pid, so the app list filled with
  anonymous rows that no classification rule could ever match. `comm` is
  world-readable and is now the fallback.
* **Window titles kept xprop's escaping.** A window called `notes"final.txt"` was
  stored as `notes\"final.txt\"`, showing the user backslashes that are not in
  their filename. Unescaping is a single left-to-right pass, because a literal
  backslash and a literal quote interact.
* **macOS app names were split on commas.** AppleScript returns a list joined with
  `", "`, and an application called `Foo, Inc.` became two invented apps. The
  script now emits a Unit Separator, which an application name cannot contain.

## Adding a platform

1. Implement `Collector` in `packages/daemon/src/collector/<platform>.ts`.
   Report honestly in `status()` what you *cannot* see — a collector that claims
   window titles it does not have will produce confident nonsense.
2. Register it in `collector/index.ts`. Fall back to `NullCollector` with a
   reason, never a silent empty sample.
3. Set `recommendedSampleIntervalMs` to what the platform can sustain. A
   subprocess-based collector should ask for 2 s rather than spend the machine's
   CPU measuring it.
4. Add a live test that skips cleanly off-platform.

Nothing above the collector layer is platform-aware; if you find yourself adding
a platform branch in `engine.ts` or `analytics.ts`, the abstraction is wrong.
