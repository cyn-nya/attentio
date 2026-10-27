# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/cyn-nya/attentio/security/advisories/new)
or email the maintainer rather than filing a public issue. Please include what
you did, what happened, and what you expected. A reproduction is worth more than
a description.

This is a small project maintained by one person, so there is no SLA. You will
get an answer, and if the report is valid you will be credited unless you ask
otherwise.

## What counts as a vulnerability

Attentio reads almost everything about a machine's activity, so the interesting
bugs are about **disclosure**, not about remote code execution:

- **Any way to get activity data out of the machine** other than the AI provider
  the user configured. This includes a remote API path that bypasses
  authorization, and any outbound request to somewhere the user did not choose.
- **A way to read the database without filesystem access.** For example an HTTP
  route that leaks a path, a directory traversal in the static host, or an API
  endpoint that returns raw segments when it should return aggregates.
- **Secret material surviving where it should not.** Excluded applications must
  disappear *before* storage; if a password manager's name or window title can be
  found in `attentio.db`, that is a bug even though the process ran normally.
- **A redaction failure.** If `buildRedactedPayload` can emit a window title,
  file path or journal entry that the configured level says it should not, that
  is a vulnerability, not a display bug.
- **Authorization bypass.** A request from a non-loopback address must always
  require a valid token, with no configuration that turns that off.

## What is not a vulnerability

- **The dashboard has no TLS.** It is designed for a LAN and says so. Do not
  port-forward it to the internet. See [PRIVACY.md](docs/PRIVACY.md#remote-access).
- **Loopback requests are unauthenticated.** A local process that can reach
  `127.0.0.1` could read `attentio.db` directly anyway, so requiring a token there
  would add friction without adding protection. Set `remote.requireAuth: true` if
  you want it checked on loopback too.
- **The SQLite file is not encrypted.** A key stored next to the database
  protects you from nobody, and a passphrase you must type stops the daemon from
  starting at login. Use your operating system's disk encryption instead.
- **Someone with administrator rights can read the data.** They can also read
  your browser history, so this is not the weak link.
- **A local user can kill the daemon.** Denial of service against a tool on your
  own machine is not a security boundary.

## Hardening notes for readers of the code

Every claim above is meant to be checkable. These are the places to check:

| Claim | Where |
|---|---|
| No input hooks or screenshots | `packages/daemon/src/collector/win32.ts` — search for `SetWindowsHookEx`, `GetAsyncKeyState`, `BitBlt`. There are none |
| Exclusions applied before storage | `packages/daemon/src/engine.ts` |
| Redaction is a pure, callable function | `buildRedactedPayload` in `packages/daemon/src/report.ts` |
| No outbound traffic except the AI endpoint | `packages/daemon/src/ai.ts` — the only `fetch` in the daemon |
| One authorization chokepoint | `authorize()` in `packages/daemon/src/server.ts` |
| Static host refuses traversal | `packages/daemon/test/static.test.ts`, five encodings |
| The engine never counts itself | `selfPid` / `selfExe` in `packages/daemon/src/engine.ts` |

If a claim in the table is false, that is itself a reportable finding even if
nothing is exploitable: the documentation would be lying to the user.

## Dependencies

Two runtime dependencies, both deliberate:

- `koffi` — Win32 FFI. Chosen over a compiled native addon because it needs no
  compiler, which is what makes `npm install` work on a machine with no
  build tools. It is the only code in the project that calls into the OS.
- `preact` — the dashboard, and it is optional: the CLI and the API are fully
  functional without the web app ever being built.

Everything else — SQLite, HTTP, test running, argument parsing, colour, tables —
is the Node standard library, which is the main reason this project has almost no
supply-chain surface.
