# Contributing

## Getting set up

```bash
npm ci
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run coverage
npm run build     # dual ESM + CJS into dist/
```

## What a change needs

- **A test that fails without it.** For anything touching the failure paths,
  the test should demonstrate the bad outcome, not just the good one — the
  concurrency test's claims were checked by disabling the lock and watching
  hundreds of log lines duplicate.
- **`npm run typecheck` and `npm test` clean.** The build is `strict`, with
  `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; the suite must be
  deterministic, so prefer injecting a timestamp over sleeping.
- **No runtime dependencies.** CI enforces this. Everything comes from
  `node:fs`, `node:zlib` and `node:stream`.

## Things worth knowing before changing the core

- **Never delete data to make an error tidy.** If contents have left the live
  file, they either go back or stay on disk. Every path in `Source` is written
  around that rule.
- **`rename` and `copy-truncate` are not interchangeable.** One is atomic and
  loses nothing but breaks a foreign writer's descriptor; the other keeps the
  inode and has an irreducible race. Changes to either belong with a test in
  `test/safety.test.ts`.
- **Comments explain why, not what.** The unusual lines here — an explicit
  `chmod` after `open`, an error listener attached before a `pipe`, a lock that
  distrusts a live pid after a day — are all guarding against something
  specific. Say what.

## Commit messages

Short imperative subject, and a body explaining the reasoning when the change
is not obvious from the diff.
