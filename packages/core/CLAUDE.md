# @schrodump/core

The base package. Takes precedence over the root `CLAUDE.md` inside this directory.

## Invariants (non-negotiable)

- **Zero I/O, zero network, zero Docker, zero Prisma, zero filesystem.** Pure functions.
- **One runtime dependency: `zod`.** If importing another workspace package starts to look
  necessary, **stop and report it** — the abstraction is wrong.
- **Per-engine differences live in exactly one table.** `CAPABILITY_MATRIX` in `src/capabilities.ts`
  is a `Readonly<Record<EngineKind, EngineCapabilities>>`, and it is the only place in this package
  that encodes a difference between engines; everything else consumes `resolveCapabilities`. Adding
  an engine is a **row in that table**, never a new `if`/`switch` on `engine` somewhere else — and
  because the type is a total `Record`, a missing engine fails the typecheck instead of silently
  falling through. Same rule as the `registry.ts` of `@schrodump/engines`.
- **No barrel `index.ts`.** The public API is exposed per subpath through `exports` in
  `package.json` — today `./types`, `./execution`, `./capabilities`, `./manifest`, `./retention`
  and `./errors`. Export explicitly, and only what is public.
- The manifest **never** carries a credential, a connection string, key material or a sample of
  data. `keyIds` are fingerprints.

## Retention answers, it does not decide

`resolveRetention` is a pure function over the GFS counters and it answers the question it was
asked. Every `keep*` counter defaults to 0, so "I did not configure retention" and "I want to keep
zero copies" arrive here identically — and the honest answer to the second is *delete everything*.
Guarding that is the caller's job (`retentionIsConfigured`, then `apps/server`), which is why that
guard exists rather than a defensive default hidden in here. Silence is not an instruction, and
this package is not the place to guess which silence it was.

## SPDX

Every source file begins with:

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
