<div align="center">

# Attentio

**Know where your attention actually went — on every machine you use.**

Local-first · no account · optional AI · Windows / Linux / macOS

</div>

---

## What this is

Attentio watches your own computer and answers questions that ordinary time
trackers get subtly wrong:

- **Which window was actually in front of me, and for how long?**
- **Which apps were working in the background while I was doing something else?**
  (the compiler, the render, the sync client — work you did *not* have on screen)
- **Where did the CPU go?** Per-process, per-minute, not a single "system load" number.
- **Was I focused, or just busy?** With a score you can argue with, because every
  factor is named and explained.
- **What did I say I was going to do, and did I do it?**

Then it writes you a **diagnosis** (诊断书) and a **work log** (工作日志), and it
lives on your desktop as a small companion that you can talk to.

## Why not just use an existing tracker?

Attentio is not "another ActivityWatch". Three things are genuinely different:

| | What Attentio does differently |
|---|---|
| **Two clocks, not one** | Every second is billed to exactly **one** of *engaged* (foreground), *background* (running, contributing CPU, not visible), or *away*. Most trackers only count the first, so a 40-minute build looks like 40 minutes of nothing. |
| **Explainable focus** | The focus score is a weighted sum of five named factors — engagement, depth, continuity, fragmentation, coherence — and the UI shows each factor's contribution, the plain-language reason, and a **confidence** level based on how much data it actually has. No black-box "productivity score". |
| **Yours, offline, forever** | SQLite in `~/.attentio`. No account, no cloud, no telemetry. AI is **opt-in**, and when on, you see the exact redacted payload before it is ever sent. |

## Privacy is a design constraint, not a setting

- **Local-first.** Your activity never leaves the machine unless you turn on AI
  reports, and even then only a redacted summary of statistics is sent.
- **Never recorded:** keystrokes, clipboard, screenshots, file contents, passwords.
- **Password managers are excluded by default** — 1Password, Bitwarden, KeePass,
  LastPass, Dashlane and friends are folded into a `@private` bucket that counts
  *time* but stores **no** app name, path, or window title.
- **Excluded time is still counted.** It lands in `@private` instead of vanishing,
  so your day's totals keep adding up to 24 hours and you never wonder about holes.
- **The remote API requires pairing.** Nothing is reachable from your phone until
  you approve a device with a one-time code.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the full statement, including the
complete list of what is collected.

## Status

**Early development, Windows-first.** This is real, tested code — not a mockup —
but the surface is still small. Honest current state:

| Area | State |
|---|---|
| Windows collector (foreground window, idle, per-process CPU/memory, window inventory) | **Working**, verified on a live machine |
| Minute accounting (`engaged` / `background` / `away` / `@private`) | **Working** |
| Classification rules (12 categories, 73 rules, heavy zh-CN app coverage) | **Working** |
| Focus scoring with per-factor explanations and a confidence level | **Working** |
| SQLite persistence, retention, migrations | **Working** |
| CLI — `start today report why tasks journal pair trend config export doctor` | **Working** |
| HTTP API (REST + SSE) | **Working** |
| Web dashboard — today, timeline, apps, focus, tasks, journal, reports, settings | **Working**, installable as a PWA |
| Tasks (natural-language quick-add) and journal | **Working** |
| AI reports (bring your own key, payload preview before sending) | **Working**, off by default |
| Desktop pet | **Working** |
| Phone (PWA over LAN with pairing) | **Working** |
| Reminders (in-page, system notification, CLI) | **Working** — fired by the daemon, not the browser |
| Automatic daily report | **Working**, written locally by default |
| Voice input for tasks | **Working** — Chromium only, and the audio leaves your machine ([why](docs/PRIVACY.md#voice-input)) |
| Configurable day boundary | **Working** — a 01:30 session counts as the previous evening |
| Android / HarmonyOS native app | Planned — the PWA works today, see [docs/ROADMAP.md](docs/ROADMAP.md) |
| Linux / macOS collectors | Implemented; their parsing is unit-tested, the collectors themselves are not run in CI |

**Where to look first:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the
pieces fit, [docs/ROADMAP.md](docs/ROADMAP.md) for what is not built yet and why,
[docs/PRIVACY.md](docs/PRIVACY.md) for the full data statement.

### Why Windows first?

Because that is where the honest engineering is hard. Attentio talks to Win32
directly through [`koffi`](https://koffi.dev) FFI — which means **no C++ compiler,
no node-gyp, no MSVC build tools**: `npm install` just works. A full sample
(≈200 processes, CPU + memory, plus the foreground window and a window
inventory) costs well under 50 ms, so 1 Hz sampling is affordable.

## Install and run

Requires **Node 24+**. Attentio runs TypeScript directly (no build step for the
CLI and daemon) and stores data with the built-in `node:sqlite`; both need a
recent Node, and 24 is what is tested in CI.

```bash
git clone https://github.com/cyn-nya/attentio.git
cd attentio
npm install       # builds the packages and the dashboard; no compiler needed

npm start         # start sampling and serve the dashboard
```

Then open <http://localhost:8787> on this machine, or `attentio pair` to use your
phone. If port 8787 is already taken by something else, Attentio notices that the
port is answering with *someone else's* service and moves itself rather than
silently losing your traffic.

Day to day:

```bash
npm run today     # the day's numbers in the terminal
npm run report    # the written diagnosis
npm run why       # why is this app classified the way it is
npm run doctor    # what can Attentio actually see on this machine?
npm test          # 43 tests
npm run test:web  # render every dashboard view with synthetic data
npm run verify    # typecheck + all suites + build
```

`attentio doctor` is the first thing to run on any machine. It reports exactly
which capabilities your platform and session expose — and says so plainly when it
is half-blind, instead of quietly recording zeros. It also lists every app it
could not classify, with a paste-ready rule for each one.

### Use it from your phone

```bash
npm start                    # prints a LAN URL and a six-digit pairing code
```

Enter the code on the phone, and the dashboard installs to the home screen and
works over your local network. The code is single-use and expires in five
minutes. Nothing is reachable from another device until you have approved it:
loopback is trusted, and every other address needs a token. See
[PRIVACY.md](docs/PRIVACY.md#remote-access) for the threat model, including what
is deliberately *not* protected.

## Design in one picture

```
  collector            accumulator                 storage
 ┌──────────┐        ┌──────────────┐        ┌──────────────────┐
 │ Win32    │ window │  segments    │        │ segments   (raw, │
 │ /proc    ├───────►│  (timeline)  ├───────►│   prunable)      │
 │ osascript│ process│              │        │ rollups    (per  │
 │          ├───────►│  per-minute  │        │  minute, forever)│
 │          │ invent.│  accounts    │        │ tasks / journal  │
 └──────────┘        └──────────────┘        └──────────────────┘
       ▲                                             │
       │ one clock, one writer                       ▼
   the Engine                                   analytics → report
                                                SSE → web / phone
```

Two rules hold the whole thing together:

1. **One clock.** The engine stamps every sample. A collector that reports a
   stale or zero timestamp cannot corrupt the timeline.
2. **One writer.** Only the engine writes activity data. Everything else reads.

## Architecture

| Package | Responsibility |
|---|---|
| `packages/shared` | Pure, dependency-free domain logic: types, the 12-category taxonomy, classification rules, title normalisation, the activity accumulator, focus scoring, aggregation, time helpers, API contracts. Never touches the OS. |
| `packages/daemon` | Platform collectors, the engine, SQLite persistence, analytics, HTTP server. |
| `packages/cli` | The `attentio` command. |
| `apps/web` | Responsive PWA: today, timeline, apps, focus, tasks, journal, reports, settings, pet. |

Full detail, including the sampling pipeline and the data model, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The split matters: `shared` is where the arithmetic lives, and it is fully
unit-tested without a display, a database, or a network.

## Contributing

The most valuable contributions right now, roughly in order:

1. **Classification rules** for software you actually use, especially non-English
   or regional apps. `packages/shared/src/defaultRules.ts`.
2. **Linux (Wayland) and macOS foreground-window collectors.** Both are
   implemented but weaker than Windows; see the TODOs in
   `packages/daemon/src/collector/`.
3. **Analytics and UI.**

Please run `npm test && npm run typecheck` before opening a PR.

## 中文简介

Attentio 是一个**本地优先**的注意力与效率分析工具，用来回答普通时间统计软件答不好的问题：

- **前台窗口**到底是哪个、用了多久；
- 哪些程序**在后台真正干了活**（编译、渲染、同步——你并没有看着它）；
- CPU **被谁吃掉了**，精确到进程和分钟；
- 我是**真的专注**，还是只是很忙——专注分由五个**具名、可解释**的因子组成，并给出数据置信度；
- 我说过要做的事，做完了吗。

它会生成**诊断书**和**工作日志**，并作为一只**桌宠**陪在你桌面上。

**隐私**：数据只存在本机 `~/.attentio` 的 SQLite 里；不记录键盘、剪贴板、截图、文件内容与密码；
密码管理器默认被排除，且被排除的时间仍然计数（归入 `@private`），只是不留任何内容；
AI 报告默认关闭，开启前你会看到将要发送的脱敏内容。

目前为**早期开发版，Windows 优先**，其余平台与手机端在计划中。

## License

MIT © Attentio contributors
