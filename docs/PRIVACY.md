# Privacy

Attentio watches what your computer does all day. That is an uncomfortable
thing for software to do, so the rules it follows are written down here, in
full, rather than left to a settings screen you will never open.

The short version: **everything stays on your machine, and the things that would
actually hurt you are never recorded at all.**

---

## What is recorded

For every sampling interval (1 second by default) Attentio stores a row
containing:

| Field | Example | Why |
|---|---|---|
| Timestamp | `2026-03-02T09:14:05+08:00` | To attribute time |
| Application name | `VS Code` | To answer "where did the time go" |
| Executable path | `C:\Program Files\Microsoft VS Code\Code.exe` | To classify reliably across renamed windows |
| Window title | `engine.ts — attentio` | To tell *which project or page*, not just which app |
| Category | `deep-work` | The only thing reports really need |
| Idle seconds | `0` | To distinguish engaged from away |
| Per-process CPU and memory | `18%`, `2.1 GB` | To see background work that no window shows |

With window titles turned off (`captureTitles: false`), the title field is
dropped before the row is written. Time still adds up; the page you were reading
does not.

### How window titles are reduced

Raw titles are noisy and often contain things you would not want in a database
forever: document names, email subjects, chat partner names, URLs with query
strings. Before storage, titles are normalised by `packages/shared/src/titlenorm.ts`:

- browser titles are reduced to a site-level context, not a full URL;
- editor titles are reduced to a project or file name;
- chat window titles are reduced to the application, not the conversation.

The normalised form (`context` and `detail`) is what analytics and reports use.
Set `captureTitles: false` to skip even that.

### What is kept long-term

Raw segments are pruned automatically after `segmentRetentionDays` (90 by
default). What survives is the **minute rollup** — `(device, minute, app,
category)` — which is small enough to keep forever and contains no window
titles at all.

---

## What is never recorded

This is a commitment, not a configuration option. There is no setting that turns
any of these on, because the code to capture them does not exist:

- **Keystrokes.** No keyboard hooks, no keylogger, no input logging of any kind.
- **Clipboard contents.**
- **Screenshots, screen recording, or OCR.**
- **File contents.** Attentio reads window titles and process metadata; it never
  opens your documents.
- **Passwords, form fields, or browsing history.** The browser's history database
  is not touched.
- **Mouse movement or clicks.** idleness is read from the OS's own
  `GetLastInputInfo` counter — a single number, not a stream of events.
- **Audio, camera, location, contacts, or anything else.**
- **Telemetry.** Attentio never phones home. There is no analytics endpoint, no
  crash reporter, no update ping.

If you find code in this repository that captures any of the above, that is a
security bug and we want it reported as one (see [SECURITY.md](../SECURITY.md)).

---

## Apps that are excluded on purpose

Password managers and a few similar tools are excluded **by default**:

1Password, Bitwarden, KeePass, LastPass, Dashlane, Enpass, and their browser
extensions.

When an excluded app has focus, Attentio records time against a reserved
pseudo-app called `@private`. That row contains:

- the duration,
- the category `system`,
- the literal string `@private`.

It does **not** contain the real application name, the executable path, or any
window title. The app is invisible in your timeline.

**Excluded time is still counted.** This matters more than it sounds: if private
time simply vanished, your totals would not add up to your day, and you would
start wondering what the tool was hiding from you. Instead `@private` appears as
a plain block with no detail, and `engaged + background + away` continues to
equal the wall-clock span. You can see that time was spent. You cannot see on
what — and neither can anything reading the database.

You can add to `excludeApps` and `excludeTitlePatterns` in
`~/.attentio/config.json`. Title patterns are case-insensitive regular
expressions matched against the raw window title before anything is stored.

---

## AI reports

AI is **off by default** and requires you to supply your own API key. When it is
on:

1. Attentio builds a payload from your **statistics**, not your raw activity. By
   default this is application names, categories, durations, focus factors and
   the text you wrote in your own journal.
2. The payload is *redacted* according to `ai.redaction`:

   | Level | What is sent |
   |---|---|
   | `none` | App names, window contexts, journal text |
   | `app` **(default)** | Application names and durations; window titles replaced with their category |
   | `category` | Only the 12 category buckets and totals — no application is named at all |
   | `stats` | Only aggregate numbers: durations, switch counts, focus factors |

3. You can read the exact JSON before it leaves the machine. The API exposes it
   (`GET /api/reports` preview, and `attentio report --dry-run` on the CLI), and
   nothing is transmitted until you confirm.
4. If the model call fails for any reason — no key, no network, rate limit — the
   report falls back to the deterministic local narrative and tells you it did.

To disable AI entirely, leave `ai.enabled` false. Everything except the prose in
the report works identically, because the report has a local implementation
first and the model is an optional rewriter on top of it.

---

## Remote access

The dashboard is served over HTTP on your LAN so your phone can reach it. That
is a real exposure and is treated as one:

- **Loopback is trusted; everything else is not.** A request from `127.0.0.1`
  needs no credentials. A request from any other address needs a bearer token,
  always, with no setting to disable it.
- **Tokens come from pairing.** Run `attentio pair` on the machine; it prints a
  six-digit code valid for five minutes. The phone exchanges that code for a
  long-lived token. Codes are single-use.
- **Tokens can be revoked.** `attentio pair --list` and `--revoke` manage the
  device list; revoking takes effect on the next request.
- **The API is deliberately small.** It can read your statistics and manage your
  own tasks and journal. It cannot read your files, run commands, or change
  tracking settings from a remote device.
- **No TLS.** Traffic on your LAN is unencrypted, so anyone who can already
  sniff your network can read the statistics. If that is a concern on a network
  you do not control — campus Wi-Fi, a café — set `remote.enabled: false` and
  use the desktop dashboard instead. Do not port-forward this service to the
  internet.
- **Some networks hand out public addresses.** Many university and corporate
  Wi-Fi networks give clients routable IPs rather than private ones, which means
  "your LAN" is the whole internet. Attentio only offers *private* addresses
  (10/8, 172.16/12, 192.168/16, 169.254/16, 127/8) as a phone URL, and reports a
  routable one as `exposed` with a warning naming the remedy. If you see that
  line, the dashboard is reachable from outside your network, and the pairing
  token is the only thing protecting it.

If you bind to a non-loopback address, Attentio says so at startup, including
the exact URLs it is reachable at, so this is never a surprise.

---

## Where your data lives

Everything is in one directory, `~/.attentio` (`%USERPROFILE%\.attentio` on
Windows):

```
~/.attentio/
  attentio.db     SQLite: devices, segments, rollups, tasks, journal, reports, tokens
  config.json     your settings
  logs/           daemon logs
```

`attentio export` dumps the whole thing as JSON. `attentio export --csv` gives
you spreadsheets. Deleting the directory deletes everything, permanently — there
is no copy anywhere else, because there is no server to have one.

The file is protected by normal filesystem permissions. If someone else can read
`attentio.db`, they can read your activity history; on a shared machine, use
your OS's disk encryption. Attentio does not encrypt the database itself,
because an encryption key stored next to the database protects you from nobody,
and a passphrase you must type would stop the daemon from starting at login.

---

## What a hostile reader of this code should check

These are the claims above that are falsifiable from the source, listed so you
can verify them rather than trust them:

- No input hooks: `packages/daemon/src/collector/win32.ts` calls
  `GetLastInputInfo`, `GetForegroundWindow`, `GetWindowTextW`, and process APIs.
  Search it for `SetWindowsHookEx`, `GetAsyncKeyState`, `BitBlt` — there are none.
- Exclusions are applied before storage, not before display:
  `packages/daemon/src/engine.ts`.
- Redaction happens before the network call, and the redacted payload is a pure
  function you can call yourself: `buildRedactedPayload` in
  `packages/daemon/src/report.ts`.
- There is no outbound network call except the configured AI endpoint:
  `packages/daemon/src/ai.ts`. Grep for `fetch(` in the daemon.
- Remote authorization is a single chokepoint: `authorize()` in
  `packages/daemon/src/server.ts`.
