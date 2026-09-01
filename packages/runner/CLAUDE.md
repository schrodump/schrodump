# @schrodump/runner

Docker execution and scratch management. Takes precedence over the root `CLAUDE.md` here.

## Invariants

- Imports **only** `@schrodump/core`. **Never** imports `engines` or `storage`.
- Division of responsibility: `engines` says **what** to execute (image, command, args); the
  runner says **where**. Today there is only `DockerRunner`; when physical backup arrives,
  `AgentRunner` implements the same `Runner` without touching `engines`.
- The runner **does not know the destination** of the stream. It exposes the output; connecting
  that to storage is `apps/server`'s job. Keep the boundary.

## Execution (`docker.ts`) — what breaks silently

- **Exit code** always from `container.wait().StatusCode`, never from stdout EOF. Success only
  when `StatusCode === 0`.
- **No `AutoRemove`**: remove the container by hand in the `finally`, after reading the exit code
  and stderr.
- **Network** always explicit (`RunOptions.network`), never inherited. A non-existent network is a
  clear error, never a run on the default network.
- **Timeout** mandatory: on expiry, kill the container and propagate a typed error. A user
  cancellation kills the container too.
- **stderr** always captured, truncated and **sanitised** (database client messages leak
  host/user/password).

## Stream composition (`pipeline.ts`)

`composeStreamPipeline` uses `node:stream/promises` `pipeline()` rather than chained `.pipe()`,
and the reason is the project thesis applied to a stream: with `.pipe()`, an error in a middle
stage is dropped on the floor and the destination still closes cleanly — which is precisely how a
broken stream ends up reported as a successful backup. `pipeline()` aborts the whole chain and
rejects. The final `Writable` is supplied by the caller, which is what keeps the storage boundary
out of this package.

## Scratch (`scratch.ts`)

> Scratch holds the **dump in clear**. In `directory` mode the writer is `pg_dump`/`mydumper`
> itself, so there is no way to encrypt inline. Mitigation: a dedicated volume, `0700`, deletion
> in the `finally`, and **an encrypted filesystem on the host** — that last one is the operator's
> responsibility and has to be in the deployment documentation.

> **Graceful `SIGTERM`:** the server installs the handler (`jobs/shutdown.ts`), not the runner. On
> the signal it stops claiming new jobs, aborts the shared `AbortSignal` — which makes the
> in-flight `run()`/`withEphemeralService()` force-kill its container and reject with
> `RUNNER_ABORTED` — waits for the tick to settle (`whenIdle()`) under a budget
> (`SCHRODUMP_SHUTDOWN_GRACE_MS`, default 8s) and only then disconnects. The executor's `finally`
> releases the scratch reservation on that abort exactly as it would on an ordinary error, so the
> clear-text dump of an interrupted job is normally **removed during shutdown**, not left for the
> next sweep. Residual risk: a `SIGKILL` arriving before the grace expires (or before the handler
> finishes) skips that path entirely — there the boot-time sweep (`sweep`, by age) is still the
> backstop. See `docs/roadmap.md` and `docs/security.md`.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
