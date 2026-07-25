# SIGTERM graceful shutdown — abort + clean — design

- **Date:** 2026-07-25
- **Status:** approved, ready for implementation plan
- **Scope:** install a real `SIGTERM`/`SIGINT` handler in the **server process** that aborts the
  in-flight worker job, tears down its executor container, and releases its scratch reservation
  (the cleartext dump) **at shutdown** — instead of leaking both until the next-boot sweep.

## The problem

A `docker stop` (or any `SIGTERM`) on the server container today is delivered correctly —
`dumb-init` forwards it, `entrypoint.sh` re-signals its children — but the Node server process
has no effective shutdown for an in-flight job. `installShutdown` (`jobs/loop.ts:38`) exists and
its `onSignal` (`server.ts:145`) calls `handle.stop()` + `schedulerHandle.stop()` + a
`$disconnect`, then `process.exit(0)` **immediately**. `startLoop.stop()` only clears the timer;
it does **not** await or cancel the tick already running. So when a backup/restore is mid-flight:

- **The executor container is orphaned.** Containers run `AutoRemove: false` (`docker.ts:296,339`,
  deliberately, so exit code + stderr are read first). The `finally` that removes it never runs
  under `process.exit`, so it is left on the daemon.
- **The scratch directory survives, holding a cleartext dump.** The reservation's `finally`
  (which removes the `0700` dir) never runs either; the dump in clear lingers until the
  `ScratchManager` age-based sweep on the next boot. That window is the one thing the whole
  crypto-at-rest story is supposed to close. Documented today in `packages/runner/CLAUDE.md`
  ("Gap conhecido"), `docs/roadmap.md` (known limitations) and `docs/security.md`.
- **The job row stays `RUNNING`** until boot orphan-recovery (`recoverOrphanedJobs`) marks it
  `FAILED` on the next boot.

The grace budget is real: `docker stop` gives ~10s before `SIGKILL`. A logical dump takes minutes
to hours, so **waiting for the job to finish (drain) is not viable** — the `SIGKILL` arrives
mid-dump and we are back to the leak. The design decision (below) is therefore to **abort**, not
drain.

## The decision

On `SIGTERM`, **actively abort the in-flight job and clean up**, rather than wait for it. An
unfinished backup is a `FAILED` job and an `UNOBSERVED` (or absent) artifact — fully consistent
with the thesis — and, crucially, **no cleartext survives the shutdown**. The goal of shutdown is
*leave no trace*, not *finish the backup*.

## Architecture

A single process-wide `AbortController`, tripped by the signal handler, whose `signal` is threaded
into every container-creating runner call. On abort the runner force-removes the container —
reusing the **exact path the timeout already uses to kill a container** (the runner's stated
invariant: "Cancelamento do usuário também mata o container"). Removing the container makes the
`run()` promise reject; the executor's existing `finally` releases the scratch reservation
(removing the `0700` dir), and the existing `catch` in `runWorkerOnce` (`worker.ts:78`) marks the
job `FAILED`. **No new database-write logic is added** — the abort rides the failure paths that
already exist.

```
SIGTERM
  │
  ├─ handle.stop() / schedulerHandle.stop()      stop claiming new jobs (already present)
  ├─ shutdownController.abort(Error("shutdown"))  trip the signal
  │     └─ runner: signal → container.remove(force)  (reuses the timeout kill path)
  │           └─ run() rejects
  │                 └─ executor finally  → scratch reservation released (0700 dir removed)
  │                 └─ runWorkerOnce catch → failJob(job, "aborted by shutdown")
  ├─ await in-flight tick settles  (bounded by SCHRODUMP_SHUTDOWN_GRACE_MS)
  │     └─ on grace timeout: log and proceed — boot sweep + orphan-recovery are the backstop
  ├─ advisoryLockPrisma.$disconnect()
  └─ process.exit(0)
```

> **Correction (post-implementation):** the diagram's `stop claiming new jobs` annotation on
> `handle.stop()` and §3's "thread the signal through `drainQueue`" were the wrong mental model.
> `handle.stop()` only halts new **ticks**; the in-flight tick's `drainQueue` while-loop keeps
> calling `claimNextJob` after abort and would mass-FAIL every queued job. Claiming is actually
> stopped by gating `claimNextJob` on the shutdown signal inside the worker store
> (`worker-wiring.ts`'s `createWorkerStore`), not by threading the signal into `drainQueue` itself.

### Components and changes

1. **`packages/runner` — cancellation input.**
   - `RunOptions` (`runner.ts:17`) gains `readonly signal?: AbortSignal`.
   - `withEphemeralService` (`runner.ts:58`) gains an optional third parameter
     `opts?: { signal?: AbortSignal }` so the verify sandbox and its inner `run` calls are
     cancellable too.
   - `docker.ts` `run()` and the ephemeral-service start: register an `abort` listener that
     force-removes the container (`container.remove({ force: true })`) via the same teardown the
     timeout uses. If the signal is already aborted on entry, do not start the container. Listener
     is removed on settle to avoid leaks. The existing idempotent `.catch(() => undefined)` on the
     `finally` removals covers the abort-vs-finally race.

2. **`apps/server/src/jobs/loop.ts` — awaitable ticks + threaded signal.**
   - `startLoop` tracks the in-flight tick promise and exposes `whenIdle(): Promise<void>` so the
     shutdown can await a tick that is already running (today it is fire-and-forget).
   - `installShutdown` stays the orchestrator but its `onSignal` now performs the full sequence
     (abort → awaited drain with grace → fallback). The grace/`whenIdle` wiring lives in
     `server.ts`, which owns the controller and handles; `loop.ts` stays generic.

3. **`apps/server/src/jobs/worker.ts` + executor wiring — pass the signal down.**
   - `WorkerDeps`/`drainQueue`/`runWorkerOnce` thread an `AbortSignal` to the `JobExecutor`
     methods (`runBackup`/`runVerify`/`runRestore`).
   - The executor (`worker-wiring.ts`) passes `signal` into each `runner.run(...)`
     (`backup-wiring.ts:69`, `restore-executor.ts:340`, `worker-wiring.ts:749`) and
     `withEphemeralService(...)` (`worker-wiring.ts:666`) call.

4. **`apps/server/src/server.ts` — the sequence.**
   - Create `const shutdownController = new AbortController()` at worker boot; pass its `signal`
     into `workerDeps`.
   - Rewrite the `installShutdown({ onSignal })` body to: stop both loops, `abort()`, then
     `await Promise.race([handle.whenIdle(), sleep(SCHRODUMP_SHUTDOWN_GRACE_MS)])`, then
     `$disconnect`. `process.exit(0)` is already handled by `installShutdown`. No resource
     registry is introduced: the abort rides the executor's existing cleanup paths, and the
     grace-expiry case (below) falls through to the unchanged boot-time backstop.

5. **Config + compose.**
   - `env.ts`: new `SCHRODUMP_SHUTDOWN_GRACE_MS` (Zod, positive int, **default 8000** — under
     docker's 10s).
   - `compose.yaml`: add `stop_grace_period: 15s` to the `schrodump` service (a margin over the
     internal grace; the abort itself is sub-second).
   - `docker/entrypoint.sh:32`: update the stale NOTE (it currently states no handler exists).

6. **Docs.**
   - `packages/runner/CLAUDE.md` "Gap conhecido" note and `docs/roadmap.md` known-limitations row
     ("No `SIGTERM` handler…") flip from *gap* to *shipped*, describing the abort-and-clean
     behavior and the residual (a `SIGKILL` before grace still relies on the boot sweep).
   - `docs/security.md` cleartext-window note updated to reflect shutdown-time cleanup.

### The grace timeout

`SCHRODUMP_SHUTDOWN_GRACE_MS` (default 8000) bounds the awaited drain. Because the abort force-kills
the container immediately, the executor's cleanup normally completes in well under a second; the
grace exists only so a wedged teardown (a hung Docker daemon call) cannot hold the process past the
`docker stop` window. On grace expiry the handler logs and proceeds to exit — it does **not** try
to reach into the stuck job's resources (that would need an active-resource registry this design
deliberately avoids). The boot orphan-recovery + scratch sweep remain the backstop for both the
grace-expiry and the `SIGKILL`-before-grace cases — i.e. that pathological path is no worse than
today, while the normal path is fully cleaned at shutdown.

## What is explicitly out of scope

- **The web (Next) process.** It runs no jobs, holds no scratch or containers; Next's own
  `SIGTERM` handling suffices and `entrypoint.sh` already forwards the signal. No change.
- **Draining/finishing an in-flight job.** Rejected above — impractical within a `docker stop`
  budget, and not the goal.
- **Cooperative mid-dump checkpointing / resumable backups.** Not a thing in v1; an aborted job is
  simply `FAILED` and re-runs on the next schedule.
- **Cancelling a job on user request (a "cancel" button).** The same `AbortSignal` plumbing makes
  this cheap later, but the UI/route for per-job cancel is not in this scope.

## Testing

- **Unit — runner cancellation:** with a fake dockerode, assert that aborting the signal
  force-removes the container and that `run()` rejects; that an already-aborted signal never starts
  a container; that `withEphemeralService` tears the service down on abort.
- **Unit — loop/shutdown orchestration:** `startLoop.whenIdle()` resolves only after the in-flight
  tick settles; the `onSignal` sequence aborts, awaits `whenIdle` under the grace, and falls back
  on timeout (fake timers).
- **Unit — worker signal threading:** `runWorkerOnce` passes the signal to the executor, and on an
  abort-rejected run marks the job `FAILED` with the shutdown reason.
- **Real end-to-end `SIGTERM` mid-dump** (scratch dir gone, container gone, job `FAILED`) is a
  manual/dev smoke, not a CI gate — a real-container SIGTERM harness is disproportionate to the
  gain. Stated honestly rather than faked.

## Success criteria

After `docker stop` on a server with a backup in flight:
1. No executor container for that job remains on the daemon.
2. No scratch directory for that job remains on the volume (no cleartext dump left behind).
3. The job row is `FAILED` with a clear "aborted by shutdown" reason.
4. Shutdown completes within the `docker stop` grace window (no `SIGKILL` needed in the normal
   path).
