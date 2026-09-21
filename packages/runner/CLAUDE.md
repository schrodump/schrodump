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
- **Removal takes the container's anonymous volumes** (`CONTAINER_REMOVE_OPTIONS`, `{ force: true,
  v: true }`) — executors and sandboxes alike, on success, failure, timeout and abort. The stock
  engine images (`postgres:<major>-alpine`, `mysql:8.0`, `mariadb:11`, `mongo:8`) declare a
  `VOLUME` for their data directory and nothing is mounted over it, so Docker creates an
  **anonymous volume** with every container, and `force` alone stops the container and **keeps**
  the volume. For a FULL_RESTORE verify that volume **is the restored database, in clear**: on a
  live stack three verifies left three dangling volumes, each a complete PostgreSQL data directory
  (`pg_wal`, `postgresql.conf`, `postmaster.pid`), under `/var/lib/docker/volumes`, kept forever —
  the host filling by one whole database per verify, and every backup encrypted before it left the
  host also existing unencrypted on it, against `ARCHITECTURE.md` §4 and the scratch model below.
  Dump executors from the same images left an empty one per run. The option is applied in **one** place
  (`removeWithVolumes`, inside `DockerodeEngine`), and `StartedContainer`/`StartedService.remove()`
  take no options, so no call site can drop it. A container that was created but failed to start is
  reaped **inside** the engine (`start` and `startService` both), because `run()` and
  `withEphemeralService()` only hold a handle on the return path — until this fix an executor in
  that state was not removed at all. `v` removes anonymous volumes only: the scratch bind mount and
  any named volume are never touched. `FakeEngine` cannot see removal options — the same blind spot
  the log driver hid in — so `docker.test.ts` drives the real engine against a `FakeDaemon` and
  asserts the literal `{ force: true, v: true }` (asserting against the exported constant would stay
  green with `v` deleted from it).
- **Network** always explicit (`RunOptions.network`), never inherited. A non-existent network is a
  clear error, never a run on the default network.
- **Timeout** mandatory: on expiry, kill the container and propagate a typed error. A user
  cancellation kills the container too.
- **stderr** always captured, truncated and **sanitised** (database client messages leak
  host/user/password).
- **Executors are created with no log driver** (`LogConfig: {Type: "none"}`), and that is not a
  tidiness preference. An executor's stdout **is the artifact** — `pg_dump -Fc`, `mongodump
  --archive`, the staging `tar` — and Docker's default `json-file` driver has no size limit unless
  the daemon sets one, so every byte already streaming to object storage was ALSO written to
  `/var/lib/docker/containers/<id>/<id>-json.log`, and kept, because these containers deliberately
  use `AutoRemove: false`. A production MongoDB dump took a 216 GB host to 100% full, with the
  database it was protecting on the same disk. Nothing lost: `run()` attaches BEFORE `start()`, and
  stderr comes through that same attach. The **sandbox** (`startService`) is the opposite case and
  gets the opposite treatment — its output is diagnostics, bounded by the server's verbosity, so it
  is *capped* (`10m`, one file) rather than discarded. "The sandbox could not run" is the hardest
  failure this product has to explain; discarding its log would trade a disk problem for a
  blindness problem.
- **`demuxStream` is never given the destination directly** — `demuxInto` wraps it. dockerode
  attaches a flowing-mode `data` listener and calls `stdout.write(chunk)` without reading the
  return value and without ever pausing its source, so the container's output arrives at socket
  speed and everything the consumer has not taken yet queues in memory. For a dump that queue IS
  the backup: measured on a production MongoDB, 46 GB read and 1.4 GB uploaded with the server
  holding 74 GiB of a 125 GiB host. The sink `demuxInto` hands over forwards each chunk and pauses
  the attach when the destination is full, which stops the socket, which is what finally reaches
  `mongodump` and makes it wait. The framing stays dockerode's problem; only the flow control is
  ours.
- **The create options are pure functions** (`executorCreateOptions`, `serviceCreateOptions`)
  because `DockerodeEngine` is not exported and every unit test replaces it with a fake — so what
  `createContainer` actually receives was unobservable, which is precisely where the defect above
  lived undetected through every release.

## Executor images are pulled here, because nothing else pulls them

`dockerode`'s `createContainer` does **not** pull — it answers 404 "No such image" — and neither
the server nor the entrypoint pulled either. On a fresh host the first backup of every engine
therefore failed with an opaque `docker run failed`, and an operator could not reliably pre-pull:
the tag is derived from the server version the probe is about to discover (`mariadb:11.8`,
`mongo:8`).

`DockerEngine.ensureImage` inspects and pulls when absent, and both `run()` and
`withEphemeralService()` call it before creating anything — the sandbox needs it too, since a
FULL_RESTORE verify stands up a throwaway database of the artifact's own engine version. A pull
failure is its own error (`RUNNER_IMAGE_UNAVAILABLE`) naming the image, because "docker run failed"
sent people looking at the container when the image was the thing they could act on.

## Stream composition (`pipeline.ts`)

`composeStreamPipeline` uses `node:stream/promises` `pipeline()` rather than chained `.pipe()`,
and the reason is the project thesis applied to a stream: with `.pipe()`, an error in a middle
stage is dropped on the floor and the destination still closes cleanly — which is precisely how a
broken stream ends up reported as a successful backup. `pipeline()` aborts the whole chain and
rejects. The final `Writable` is supplied by the caller, which is what keeps the storage boundary
out of this package.

## The deployment proxies the Docker socket, and this package's calls define its allow-list

`compose.yaml` does not give Schrodump the socket; it gives it `tecnativa/docker-socket-proxy`.
So **every Docker API call added here has to be permitted there**, and the two live at opposite
ends of the repository in different languages.

That drifted once, badly: the proxy shipped `EXEC: 0` while `withEphemeralService` polls a verify
sandbox's readiness with `docker exec`, so the proxy answered `403` and `FULL_RESTORE` verify could
not run on any deployment using the file we ship. Nothing caught it because the integration suite
talks to the socket **directly** — the proxy was never in the loop being tested.

`socket-proxy.integration.test.ts` now closes that: it reads the proxy's environment out of
`compose.yaml`, starts a proxy configured exactly that way, and drives pull → networks → create →
start → inspect → exec → remove through it with dockerode. The remove sends the runner's own
`CONTAINER_REMOVE_OPTIONS` and is awaited, not left to the `finally` — that cleanup swallows its
error, and a cleanup that eats a `403` proves nothing. Adding a new Docker call here, or a new option
on an existing one, means adding it to that test and, if the allow-list refuses it, to
`compose.yaml` and `docs/security.md`.

Note what the proxy is and is not: it removes endpoints this package never calls, which reduces
accidental surface. It is **not** containment — `CONTAINERS` plus `POST` accepts a create carrying
`Binds` and `Privileged`, which is root on the host, and that is what running dumps in containers
requires. See `docs/security.md`.

The allow-list is not the only thing about that proxy this package depends on. The image caps idle
connections at ten minutes (`timeout client 10m` / `timeout server 10m`, baked in, not settable by
env), and `run()` holds two connections idle for the whole job: the attach carrying a dump that
sends nothing between chunks, and the `container.wait()` long-poll that is silent until the
container exits. A `pg_restore` verify writes to the database, not stdout, so both channels are
quiet far past ten minutes — and the proxy severed them, leaving `wait()` blocked forever (bounded
only by `DUMP_TIMEOUT_MS`, 3h) with the executor orphaned. This package assumes the socket stays
open for as long as the run's own timeout, so `compose.yaml`'s `docker-proxy` entrypoint disables
both idle timeouts; the runner keeps the real ceiling (`opts.timeoutMs` → `RUNNER_TIMEOUT`, which
kills the container and thereby ends the attach and settles wait). `socket-proxy.integration.test.ts`
reproduces the cut against a short timeout and asserts the shipped config disables it.

## Scratch (`scratch.ts`)

> Scratch holds the **dump in clear**. In `directory` mode the writer is `pg_dump`/`mydumper`
> itself, so there is no way to encrypt inline. Mitigation: a dedicated volume, `0700`, deletion
> in the `finally`, and **an encrypted filesystem on the host** — that last one is the operator's
> responsibility and has to be in the deployment documentation.

> **Scratch is not the only cleartext a job puts on the host.** A FULL_RESTORE verify restores into
> a sandbox whose data directory is the image's anonymous volume, under Docker's data root — not
> under scratch, and in `STREAM` mode as much as in `STAGED`. It lives exactly as long as the
> sandbox container, which is why removal passes `v: true` (above). Residual risk, the same shape as
> scratch's: a `SIGKILL` before teardown leaves the sandbox **running**, volume and all, and nothing
> sweeps containers today (there is no label to find them by). See `docs/security.md`.

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
