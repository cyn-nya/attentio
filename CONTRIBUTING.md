# Contributing

Thanks for looking. This project is early, and the most valuable contributions
right now are **classification rules for real machines** and **an honest bug
report about a number that came out wrong**.

## Getting set up

Windows, Node 24+, no compiler required:

```bash
git clone https://github.com/cyn-nya/attentio
cd attentio
npm install          # builds packages and the dashboard
npm test             # 43 tests
npm run test:web     # 52 render checks
npm run verify       # typecheck + both suites + build
```

Then, on the machine you actually want measured:

```bash
npm run start        # samples, serves the API and the dashboard
npm run today        # the same numbers in the terminal
npm run doctor       # what this machine can and cannot see
```

`npm start` runs from source with no build step, so the edit-run loop is instant.

## Before you open a pull request

```bash
npm run verify
```

That runs the typecheck (both the Node packages and the web app), all 43 node
tests, all 52 render checks, and a full build. CI runs the same command.

## The rules that are not obvious

### 1. A number must be traceable

If you add a statistic, the user must be able to see where it came from. That
means: a classifier result carries the winning rule id, a focus factor carries
its weight and its contribution, and a day's accounts sum to the day's span.

If your change makes a number less explainable, it will be sent back not because
it is wrong but because it is unaccountable.

### 2. Never guess a category

Unclassifiable software goes to `unknown`. Do not add a broad regex that happens
to catch one more app while silently swallowing twenty others. If you want a new
app classified, add a rule for *that app*, and add the test case.

`attentio doctor` prints every unclassified app with a paste-ready rules snippet.
That output is the best source of new rules; paste it, tighten it, test it.

### 3. Time is accounted, never invented

Every elapsed millisecond goes to exactly one of engaged, background, away, or
`@private`. If you cannot determine what the machine was doing, the honest answer
is that the time belongs to `away` or is dropped as a sleep gap — not that it is
spread across whatever was running.

### 4. Privacy decisions happen before storage

Excluding an application must prevent its data from being *written*, not from
being *displayed*. Anything else leaves the real data in a file the user may copy
or share. See [docs/PRIVACY.md](docs/PRIVACY.md).

### 5. Normalise redaction at the boundary

Anything that reaches the network goes through `buildRedactedPayload`, and any
config value that widens what is sent must fall back to the narrowest option when
it is unrecognised. A typo must never be able to expose more than intended.

## Style

The codebase has opinions, and they are enforced by the compiler:

- **Node 24 type stripping.** `erasableSyntaxOnly` is on: no `enum`, no
  `namespace`, no constructor parameter properties. Relative imports carry the
  `.ts` / `.tsx` extension.
- **Strict TypeScript.** `noUncheckedIndexedAccess` is on, so an array index is
  `T | undefined`. Handle it; do not cast it away without saying why.
- **No new dependencies without a fight.** The project has two runtime
  dependencies on purpose. A dependency has to do something the standard library
  genuinely cannot, and it has to be worth the supply-chain surface in a program
  that reads everything you do.
- **No native build step, ever.** `npm install` must work on a machine with no
  compiler. This is the constraint that shaped the whole stack; do not break it.

### Comments explain why, not what

```ts
// Bad: increments the counter.
count++;

// Good: the engine refuses to count itself, because it runs on Node and so does
// every dev server on this machine — matching on the app name would hide them.
if (sample.pid === this.selfPid) continue;
```

The interesting information in this codebase is almost never *what* it does. It
is why the obvious approach was wrong.

## Adding a classification rule

Rules live in `packages/shared/src/defaultRules.ts`:

```ts
{
  id: 'com.example',                 // must match /^[a-z]+[a-z0-9-]*\.[a-z0-9.-]+$/
  exe: ['example.exe'],              // executable stem, OR
  app: ['Example App'],              // normalised window app name
  title: ['^Project —'],             // optional regex that narrows further
  category: 'communication',
}
```

Semantics that are easy to get wrong, and are covered by tests:

- `exe` and `app` are **alternatives**. Listing both does not require both to
  match; a rule matches if *either* does. This matters because some Windows apps
  report a wrapper process (`wechatappex`) while others report the real binary.
- `title` is an additional **refinement** applied on top of an `exe`/`app` match,
  not an alternative to it.
- Order matters: the first matching rule wins, so put narrower rules before
  broader ones.
- Ids must be unique. `findDuplicateRuleIds(DEFAULT_RULES)` must be empty — the
  tests check this, because a duplicate silently shadows a rule.

Add a test in `packages/shared/test/classify.test.ts` with a realistic window
title. A rule without a test is a rule that will be broken by the next refactor.

## Adding a collector

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-a-platform). The short
version: implement `Collector`, report honestly in `status()` what you cannot
see, and never return a silent empty sample where a reason is available.

## Changing the API

`packages/shared/src/api.ts` is the single contract shared by the daemon, the CLI
and the dashboard. Change it there and the compiler will find every caller. If a
change breaks the contract, say so in the pull request — the CLI is the reference
client, and a feature that only exists for the dashboard will not survive.

## Changing the UI

Because there is no browser in CI, add a render assertion to
`apps/web/smoke/render.tsx` for anything you add. Render the view with realistic
data and assert the things a person would look for. This is not busywork: it is
the only thing standing between a refactor and a dashboard that silently shows
zeros.

## Commit messages

Explain the *why*, and say what you verified. If you fixed a bug, describe how it
manifested — that sentence is often worth more than the diff. If you found
something you did not fix, say so.

## Reporting a bug that is "the number is wrong"

The most valuable reports look like this:

> `attentio today` says 2h 10m engaged, but I was in a meeting for 3 hours and my
> laptop was open the whole time.

Include the output of `attentio doctor` and the day's app table. A wrong number
is the one bug this project cannot afford, so these reports get priority over
feature requests.

## Code of conduct

Be decent. Assume the other person is trying to make something good. Nobody here
is obligated to implement your idea, and "no" is a complete answer that does not
require a justification you find satisfying.
