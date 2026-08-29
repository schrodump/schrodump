# SIGTERM Graceful Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `SIGTERM`/`SIGINT`, abort the in-flight worker job so its executor container is destroyed and its scratch reservation (holding a **cleartext dump**) is released at shutdown, instead of leaking both until the next-boot sweep.

**Architecture:** One process-wide `AbortController`, created at worker boot, whose `signal` is threaded through `WorkerDeps` → `JobExecutor` methods → every `runner.run()` / `withEphemeralService()` call. On abort the runner kills the container through **the exact path the timeout already uses**, which makes `run()` reject; the executor's existing `finally` releases the scratch reservation and `runWorkerOnce`'s existing `catch` marks the job `FAILED`. No new database-write logic, no resource registry. A guard in `runWorkerOnce` stops the drain from claiming another job on the way out.

**Tech Stack:** TypeScript ESM (`nodenext`, `verbatimModuleSyntax`), Node 22, Vitest, dockerode, Zod, pnpm workspaces.

**Spec:** [`docs/superpowers/specs/2026-07-25-sigterm-graceful-shutdown-design.md`](../specs/2026-07-25-sigterm-graceful-shutdown-design.md)

## Global Constraints

- **SPDX header on every source file** (including `.mjs`, Dockerfiles, workflows):
  `// SPDX-License-Identifier: AGPL-3.0-or-later` / `// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA`. Every file this plan touches already has it — do not drop it.
- **All identifiers, comments, commit messages, log and error messages in English.** No exceptions. (`packages/runner/CLAUDE.md` and `docs/*.md` prose stay in the language they are already written in.)
- **Dependency graph:** `packages/runner` may import only `@schrodump/core`. It must not learn anything about jobs, Prisma or the server. The signal enters the runner as a plain `AbortSignal` — a platform type, not a project type.
- **`exactOptionalPropertyTypes: true`** (see `tsconfig.base.json`). Never assign a possibly-`undefined` value to an optional property; use the codebase's conditional-spread idiom: `...(x !== undefined ? { x } : {})`.
- **`noUncheckedIndexedAccess: true`** — index access yields `T | undefined`.
- **No new npm dependency.** `AbortController`/`AbortSignal` are Node built-ins.
- **Verification commands** (run from the repo root): `pnpm typecheck`, `pnpm lint`, `pnpm test`. Integration tests stay skipped unless `SCHRODUMP_TEST_INTEGRATION=1`.
- **Baseline at the time of writing:** typecheck clean, `pnpm test` = 175 passed / 10 skipped. Any new failure is yours.

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `packages/runner/src/runner.ts` | Interface only: `RunOptions.signal?: AbortSignal`; `withEphemeralService` gains an optional third parameter. |
| `packages/runner/src/docker.ts` | The abort mechanics: refuse to start when already aborted; kill-on-abort via the timeout's own teardown; listener removed on settle. New `abortedError()` helper emitting code `RUNNER_ABORTED`. |
| `apps/server/src/jobs/worker.ts` | Carries the signal (`WorkerDeps.signal`), guards the claim, hands the signal to the executor methods. |
| `apps/server/src/jobs/worker-wiring.ts` | Accepts the signal on each executor method and forwards it to every runner call it makes. |
| `apps/server/src/jobs/backup-wiring.ts` | `BackupWiringDeps.signal` forwarded into the dump `run()`. |
| `apps/server/src/jobs/restore-executor.ts` | `RestorePipelineDeps.signal` forwarded into the restore `run()`. |
| `apps/server/src/jobs/loop.ts` | `startLoop` exposes `whenIdle()` so shutdown can await a tick already in flight. |
| `apps/server/src/env.ts` | `SCHRODUMP_SHUTDOWN_GRACE_MS` (positive int, default 8000). |
| `apps/server/src/server.ts` | Owns the `AbortController` and runs the shutdown sequence: stop loops → abort → await `whenIdle()` under the grace → `$disconnect`. |
| `compose.yaml`, `docker/entrypoint.sh` | Deploy surface: `stop_grace_period`, and the stale NOTE corrected. |
| `packages/runner/CLAUDE.md`, `docs/roadmap.md`, `docs/security.md` | The documented gap flips to shipped behaviour, with the honest residual. |

## Two decisions already taken (do not re-litigate)

1. **The claim guard lives in `runWorkerOnce`, not in `drainQueue`.** `handle.stop()` only prevents future *ticks*; the tick already running is `drainQueue`, a loop that would otherwise claim the **next** job after the aborted one fails and start a brand-new dump inside the `docker stop` budget — leaking precisely the cleartext scratch this work exists to remove. Guarding before `claimNextJob()` also protects any direct caller of `runWorkerOnce`. This closes a gap the spec did not cover.
2. **The runner aborts with `container.kill()`, not a direct `remove({force:true})`.** It mirrors the timeout path (`docker.ts:124`) exactly, so there is one teardown to maintain, and the existing `finally` still force-removes the container.

## An outcome to expect, not to fix

An aborted **BACKUP** or **RESTORE** job surfaces as `RUNNER_ABORTED` → `runWorkerOnce`'s catch → `failJob`. An aborted **VERIFY** is different and already correct: `runFullRestore`'s total catch funnels it to `classifyVerifyError`, and `RUNNER_ABORTED` is not in `RESTORE_FAILED_CODES`, so it classifies as `INCONCLUSIVE` — which sets the **job** `FAILED` ("verify inconclusive: the sandbox could not run — artifact unchanged") and leaves the **artifact** untouched at `UNOBSERVED`. That is exactly the thesis: a verify that was killed observed nothing, so it must claim nothing. Task 4 pins this with a regression test rather than leaving it to a lucky `Set` membership.

---

### Task 1: Runner — cancellation input for `run()`

**Files:**
- Modify: `packages/runner/src/runner.ts:17-25` (`RunOptions`)
- Modify: `packages/runner/src/docker.ts:64-155` (`DockerRunner.run`)
- Test: `packages/runner/src/docker.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RunOptions.signal?: AbortSignal`; a `SchrodumpError` with `code: "RUNNER_ABORTED"` and message `"run aborted by shutdown"`; module-private `abortedError(correlationId: string): SchrodumpError`.

- [ ] **Step 1: Write the failing tests**

Add `getEventListeners` to the test file's imports (a new import line, `node:events` is a built-in):

```ts
import { getEventListeners } from "node:events";
```

Append these three tests inside the existing `describe("DockerRunner.run", ...)` block:

```ts
  it("kills the container and rejects RUNNER_ABORTED when the signal aborts mid-run", async () => {
    const engine = new FakeEngine();
    engine.neverExits = true; // the dump is still running when the signal arrives
    const controller = new AbortController();
    const promise = new DockerRunner(engine).run(DESCRIPTOR, opts({ signal: controller.signal }));
    // Let run() get past networkExists + start and register its abort listener.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.killed).toBe(true);
    expect(engine.removed).toBe(true);
  });

  it("never starts a container and ends the stdout sink when the signal is already aborted", async () => {
    const engine = new FakeEngine();
    const sink = new PassThrough();
    let ended = false;
    sink.on("finish", () => {
      ended = true;
    });
    await expect(
      new DockerRunner(engine).run(DESCRIPTOR, opts({ signal: AbortSignal.abort(), stdout: sink })),
    ).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.started).toBe(false);
    expect(ended).toBe(true);
  });

  it("removes its abort listener once the run settles, so a long-lived signal never accumulates them", async () => {
    const engine = new FakeEngine();
    engine.stdoutChunks = [Buffer.from("dump")];
    const controller = new AbortController();
    const runner = new DockerRunner(engine);
    await runner.run(DESCRIPTOR, opts({ signal: controller.signal }));
    await runner.run(DESCRIPTOR, opts({ signal: controller.signal }));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @schrodump/runner test`
Expected: FAIL. The first two error on `signal` not existing on `RunOptions` (a TS error surfaced by Vitest); the third fails because no listener bookkeeping exists yet.

- [ ] **Step 3: Add `signal` to `RunOptions`**

In `packages/runner/src/runner.ts`, inside `RunOptions` (after `correlationId`):

```ts
  // Process-wide cancellation. Aborting it kills the container through the same teardown the
  // timeout uses — the shutdown path depends on this to leave no container and no cleartext
  // scratch behind. Optional: callers with no shutdown story (tests, one-off tools) omit it.
  readonly signal?: AbortSignal;
```

- [ ] **Step 4: Implement the abort in `docker.ts`**

Add the helper just above `export function createDockerRunner` (module scope, not exported):

```ts
// Cancellation error. Deliberately a RUNNER_* code: verify's classifier (verify-wiring.ts) maps
// every RUNNER_* to INCONCLUSIVE, so a verify killed by shutdown never condemns an artifact it
// did not actually observe.
function abortedError(correlationId: string): SchrodumpError {
  return new SchrodumpError("run aborted by shutdown", {
    code: "RUNNER_ABORTED",
    correlationId,
    context: {},
  });
}
```

At the top of `run()`, immediately after `const startedAt = Date.now();`:

```ts
    // Already shutting down: never start a container we would have to kill on the next tick. End
    // the caller's stdout sink first, for the same reason the missing-network path does — a
    // consumer piping FROM it would otherwise block forever on a stream nothing will ever write to.
    if (opts.signal?.aborted === true) {
      endStdout(opts.stdout);
      throw abortedError(opts.correlationId);
    }
```

Declare the listener handle next to `timer` (replacing the single `let timer` line):

```ts
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
```

Inside the `try`, immediately after the `const timeout = new Promise<never>(...)` block:

```ts
      // Cancellation rides the timeout's exact teardown: kill the container, reject the race. The
      // finally below force-removes it, and that rejection is what makes the executor's own finally
      // run — releasing the scratch reservation (the cleartext dump) before the process exits.
      const aborted = new Promise<never>((_resolve, reject) => {
        const signal = opts.signal;
        if (signal === undefined) return; // never settles — inert in the race
        onAbort = () => {
          void container.kill().catch(() => undefined);
          reject(abortedError(opts.correlationId));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
```

Widen the race:

```ts
      const exitCode = await Promise.race([execution, timeout, aborted]);
```

And in the `finally`, before the `container.remove()` line:

```ts
      // Drop the listener on every exit path: opts.signal is process-wide and outlives this run,
      // so one left behind is a leak that grows with every job the worker executes.
      if (onAbort !== undefined) opts.signal?.removeEventListener("abort", onAbort);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @schrodump/runner test`
Expected: PASS — the whole runner suite, not only the three new tests.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean. If `apps/server` fails here it is a downstream break; do not fix it in this task — it is Task 4's job.

- [ ] **Step 7: Commit**

```bash
git add packages/runner/src/runner.ts packages/runner/src/docker.ts packages/runner/src/docker.test.ts
git commit -m "feat(runner): cancel a run through an AbortSignal, reusing the timeout kill path"
```

---

### Task 2: Runner — cancellation for `withEphemeralService()`

**Files:**
- Modify: `packages/runner/src/runner.ts:54-62` (`Runner.withEphemeralService`)
- Modify: `packages/runner/src/docker.ts:157-182` (`DockerRunner.withEphemeralService`)
- Test: `packages/runner/src/docker.test.ts`

**Interfaces:**
- Consumes: `abortedError()` from Task 1.
- Produces: `withEphemeralService<T>(spec, use, opts?: { readonly signal?: AbortSignal }): Promise<T>`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("DockerRunner.withEphemeralService", ...)` block:

```ts
  it("rejects RUNNER_ABORTED and removes the service when the signal aborts during use", async () => {
    const engine = new FakeEngine({ readyAfter: 1 });
    const controller = new AbortController();
    const promise = new DockerRunner(engine).withEphemeralService(
      SERVICE_SPEC,
      () => new Promise<string>(() => undefined), // a restore that never finishes on its own
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.serviceRemoved).toBe(true);
  });

  it("never creates a service when the signal is already aborted", async () => {
    const engine = new FakeEngine({ readyAfter: 1 });
    await expect(
      new DockerRunner(engine).withEphemeralService(SERVICE_SPEC, async () => "x", {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.startServiceCalled).toBe(false);
  });

  it("aborts while readiness is still being polled, without waiting out readinessTimeoutMs", async () => {
    const engine = new FakeEngine({ readyAfter: Infinity }); // never becomes ready
    const controller = new AbortController();
    const promise = new DockerRunner(engine).withEphemeralService(
      { ...SERVICE_SPEC, readinessTimeoutMs: 60_000 },
      async () => "x",
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.serviceRemoved).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @schrodump/runner test`
Expected: FAIL — `withEphemeralService` takes two parameters, so the third argument is a TS error.

- [ ] **Step 3: Widen the interface**

In `packages/runner/src/runner.ts`, replace the `withEphemeralService` signature inside `interface Runner`:

```ts
  // Provisions an ephemeral service, waits for readiness, hands the caller a connectable
  // address, then always tears the container down — even if `use` throws or the run is cancelled.
  withEphemeralService<T>(
    spec: EphemeralServiceSpec,
    use: (handle: EphemeralServiceHandle) => Promise<T>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<T>;
```

- [ ] **Step 4: Implement the abort in `docker.ts`**

Replace the whole `withEphemeralService` method body with:

```ts
  async withEphemeralService<T>(
    spec: EphemeralServiceSpec,
    use: (handle: EphemeralServiceHandle) => Promise<T>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<T> {
    // Already shutting down: refuse before createContainer, so no sandbox is ever born into a
    // process that is leaving.
    if (opts?.signal?.aborted === true) throw abortedError(spec.correlationId);

    // Pre-flight the network exactly as run() does, and BEFORE startService — a missing network makes
    // container.start() throw AFTER createContainer already succeeded, orphaning the container we'd
    // never get a handle to remove. Failing here means no container is created in that case.
    if (!(await this.#engine.networkExists(spec.network))) {
      throw new SchrodumpError(`docker network "${spec.network}" does not exist`, {
        code: "RUNNER_NETWORK_MISSING",
        correlationId: spec.correlationId,
        context: { network: spec.network },
      });
    }

    const svc = await this.#engine.startService(spec);
    let onAbort: (() => void) | undefined;

    try {
      // Readiness polling AND `use` are both raced against the signal: readiness can wait up to
      // readinessTimeoutMs (60s in production) and `use` runs a whole restore — neither may outlive
      // the docker-stop budget. The service's own containers inside `use` carry the same signal and
      // tear themselves down; this race is what stops the SANDBOX from surviving the shutdown.
      const aborted = new Promise<never>((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal === undefined) return; // never settles — inert in the race
        onAbort = () => reject(abortedError(spec.correlationId));
        signal.addEventListener("abort", onAbort, { once: true });
      });

      const guarded = (async () => {
        await this.#waitUntilReady(svc, spec);
        return await use({ host: svc.host, port: spec.port });
      })();
      guarded.catch(() => undefined); // swallow a late rejection if the abort wins the race

      return await Promise.race([guarded, aborted]);
    } finally {
      if (onAbort !== undefined) opts?.signal?.removeEventListener("abort", onAbort);
      // Manual removal (never AutoRemove), mirroring run(): always torn down, even if `use` threw,
      // readiness never arrived, or the shutdown cancelled it.
      await svc.remove().catch(() => undefined);
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @schrodump/runner test`
Expected: PASS, including the four pre-existing `withEphemeralService` tests (they pass no third argument — the parameter is optional).

- [ ] **Step 6: Commit**

```bash
git add packages/runner/src/runner.ts packages/runner/src/docker.ts packages/runner/src/docker.test.ts
git commit -m "feat(runner): cancel the ephemeral verify sandbox on an AbortSignal"
```

---

### Task 3: Worker — carry the signal, guard the claim

**Files:**
- Modify: `apps/server/src/jobs/worker.ts:29-37` (`JobExecutor`), `:50-56` (`WorkerDeps`), `:58-80` (`runWorkerOnce`)
- Test: `apps/server/src/jobs/worker.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2 directly (the runner is reached through the executor).
- Produces: `JobExecutor.runBackup(job: ClaimedJob, signal?: AbortSignal)`, same shape for `runVerify`/`runRestore`; `WorkerDeps.signal?: AbortSignal`. Task 4 implements these against `createJobExecutor`; Task 6 supplies the signal.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/jobs/worker.test.ts`, add `signal` to `makeDeps`'s `over` parameter type (after `enqueueVerify?`):

```ts
  signal?: AbortSignal;
```

and thread it into the returned deps (replacing the `deps:` line in the return object — note the conditional spread, `exactOptionalPropertyTypes` is on):

```ts
    deps: {
      store,
      executor,
      log,
      sanitizeReason: () => "sanitized",
      ...(over.signal !== undefined ? { signal: over.signal } : {}),
    },
```

Add to `describe("runWorkerOnce", ...)`:

```ts
  it("claims nothing and reports idle once the shutdown signal is aborted", async () => {
    const { deps, store } = makeDeps({ jobs: [backupJob], signal: AbortSignal.abort() });
    expect(await runWorkerOnce(deps)).toBe("idle");
    expect(store.failJob).not.toHaveBeenCalled();
  });

  it("hands the shutdown signal to the executor", async () => {
    const controller = new AbortController();
    const backup = vi.fn(() =>
      Promise.resolve({ ok: true, artifactId: "a1", verifyLevel: "NONE" as const }),
    );
    const { deps } = makeDeps({ jobs: [backupJob], backup, signal: controller.signal });
    await runWorkerOnce(deps);
    expect(backup).toHaveBeenCalledWith(backupJob, controller.signal);
  });
```

And a new `describe` block at the end of the file:

```ts
describe("drainQueue under shutdown", () => {
  it("stops claiming the moment the signal aborts, instead of starting another dump", async () => {
    const controller = new AbortController();
    const backup = vi.fn(() => {
      controller.abort(); // the shutdown lands while this job is running
      return Promise.resolve({ ok: true, artifactId: null, verifyLevel: "NONE" as const });
    });
    const { deps } = makeDeps({
      jobs: [backupJob, backupJob, backupJob],
      backup,
      signal: controller.signal,
    });
    expect(await drainQueue(deps)).toBe(1);
    expect(backup).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @schrodump/server test -- worker.test.ts`
Expected: FAIL — `signal` is not a property of `WorkerDeps`, and `drainQueue` claims all three jobs.

- [ ] **Step 3: Implement the guard and the threading**

In `apps/server/src/jobs/worker.ts`, replace `interface JobExecutor`:

```ts
export interface JobExecutor {
  // Each method takes the process-wide shutdown signal so it can cancel the containers it starts.
  // Optional: a caller with no shutdown story (tests, integration harnesses) omits it.
  //
  // Runs the backup pipeline (which sets the job's terminal state via its own ports) and reports
  // the outcome the worker needs to decide chaining.
  runBackup(job: ClaimedJob, signal?: AbortSignal): Promise<BackupResult>;
  // Runs verify (which sets the job AND artifact terminal state via its own ports).
  runVerify(job: ClaimedJob, signal?: AbortSignal): Promise<void>;
  // Runs restore (which sets the RESTORE job's terminal state via its own ports).
  runRestore(job: ClaimedJob, signal?: AbortSignal): Promise<void>;
}
```

Add to `WorkerDeps`, after `sanitizeReason`:

```ts
  // Tripped by the SIGTERM handler. It both cancels the in-flight job's containers and stops this
  // worker from claiming another one — see the guard at the top of runWorkerOnce.
  signal?: AbortSignal;
```

At the top of `runWorkerOnce`, before `claimNextJob()`:

```ts
  // Shutting down: do not claim work this process cannot finish. Claiming here would start a fresh
  // dump inside the docker-stop budget and leak exactly the cleartext scratch the shutdown exists
  // to remove. Reporting "idle" is also what ends drainQueue's loop.
  if (deps.signal?.aborted === true) return "idle";
```

And pass the signal at the three dispatch sites:

```ts
    if (job.kind === "BACKUP") {
      backup = await deps.executor.runBackup(job, deps.signal);
    } else if (job.kind === "VERIFY") {
      await deps.executor.runVerify(job, deps.signal);
    } else if (job.kind === "RESTORE") {
      await deps.executor.runRestore(job, deps.signal);
    } else {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @schrodump/server test -- worker.test.ts`
Expected: PASS, including every pre-existing `runWorkerOnce`/`drainQueue` test.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/jobs/worker.ts apps/server/src/jobs/worker.test.ts
git commit -m "feat(server): stop claiming jobs on shutdown and pass the signal to the executor"
```

---

### Task 4: Executor wiring — forward the signal into every runner call

**Files:**
- Modify: `apps/server/src/jobs/worker-wiring.ts:313` (`runBackup`), `:407` (`createBackupPorts({...})`), `:522` (`runVerify`), `:666` (`withEphemeralService`), `:693` (verify's `runRestorePipeline`), `:749` (assertion `runner.run`), `:800` (`runRestore`), `:964` (restore's `runRestorePipeline`)
- Modify: `apps/server/src/jobs/backup-wiring.ts:24-46` (`BackupWiringDeps`), `:69` (the dump `run()`)
- Modify: `apps/server/src/jobs/restore-executor.ts:173-184` (`RestorePipelineDeps`), `:340` (the restore `run()`)
- Test: `apps/server/src/jobs/verify-wiring.test.ts`

**Interfaces:**
- Consumes: `RunOptions.signal` (Task 1), the third parameter of `withEphemeralService` (Task 2), the `JobExecutor` method shape (Task 3).
- Produces: `BackupWiringDeps.signal?: AbortSignal`, `RestorePipelineDeps.signal?: AbortSignal`. Nothing later depends on these.

- [ ] **Step 1: Write the failing test**

The mechanical forwarding is covered by the typechecker; what needs a test is the classification that keeps an aborted verify from condemning a good artifact. `apps/server/src/jobs/verify-wiring.test.ts` already imports `SchrodumpError` and defines `const err = (code: string) => new SchrodumpError("x", { code, correlationId: "c" });` — reuse it. Add inside the existing `describe("classifyVerifyError", ...)` block, next to the `classifies runner failures as INCONCLUSIVE` test:

```ts
  it("classifies a shutdown abort as INCONCLUSIVE, never FAILED — it observed nothing", () => {
    expect(classifyVerifyError(err("RUNNER_ABORTED"))).toBe("INCONCLUSIVE");
  });
```

- [ ] **Step 2: Run it to see where you stand**

Run: `pnpm --filter @schrodump/server test -- verify-wiring.test.ts`
Expected: **PASS already** — `RESTORE_FAILED_CODES` is a closed set of two `RESTORE_*` codes, so any `RUNNER_*` falls through to `INCONCLUSIVE`. This test is a lock on load-bearing behaviour that is currently an accident of that `Set`'s contents; it fails the day someone adds `RUNNER_ABORTED` to it. Keep it.

- [ ] **Step 3: Thread the signal through `backup-wiring.ts`**

Add to `BackupWiringDeps`, after `timeoutMs: number;`:

```ts
  // Shutdown cancellation, forwarded into the dump container's run().
  signal?: AbortSignal;
```

At `backup-wiring.ts:69`, inside the `deps.runner.run(descriptor, { ... })` options object, after `correlationId: deps.jobId,`:

```ts
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
```

- [ ] **Step 4: Thread the signal through `restore-executor.ts`**

Add to `RestorePipelineDeps`, after `timeoutMs: number;`:

```ts
  // Shutdown cancellation, forwarded into the restore container's run().
  signal?: AbortSignal;
```

At `restore-executor.ts:340`, inside the `deps.runner.run(...)` options object, after `correlationId: deps.correlationId,`:

```ts
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
```

- [ ] **Step 5: Accept and forward the signal in `worker-wiring.ts`**

Change the three executor declarations to take the signal:

```ts
  const runBackup = async (job: ClaimedJob, signal?: AbortSignal): Promise<BackupResult> => {
```
```ts
  const runVerify = async (job: ClaimedJob, signal?: AbortSignal): Promise<void> => {
```
```ts
  const runRestore = async (job: ClaimedJob, signal?: AbortSignal): Promise<void> => {
```

Then forward it at each of the five runner call sites. In `createBackupPorts({...})` (line ~407), after `timeoutMs: DUMP_TIMEOUT_MS,`:

```ts
      ...(signal !== undefined ? { signal } : {}),
```

In `runner.withEphemeralService(...)` (line ~666), as a **third argument** after the `async ({ host }) => {...}` callback — i.e. after the callback's closing `},` and before the call's closing `)`:

```ts
            { ...(signal !== undefined ? { signal } : {}) },
```

In verify's `runRestorePipeline({...})` (line ~693) and restore's `runRestorePipeline({...})` (line ~964), after `timeoutMs: DUMP_TIMEOUT_MS,`:

```ts
                ...(signal !== undefined ? { signal } : {}),
```

In the assertion `runner.run(...)` (line ~749), inside its options object after `correlationId: job.id,`:

```ts
                  ...(signal !== undefined ? { signal } : {}),
```

- [ ] **Step 6: Typecheck, lint and run the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean. `createJobExecutor`'s returned object now satisfies the widened `JobExecutor` because the extra parameter is optional; the integration tests that call `executor.runBackup(claimed)` with one argument still compile.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/jobs/worker-wiring.ts apps/server/src/jobs/backup-wiring.ts apps/server/src/jobs/restore-executor.ts apps/server/src/jobs/verify-wiring.test.ts
git commit -m "feat(server): forward the shutdown signal into every executor container"
```

---

### Task 5: Loop — an awaitable in-flight tick

**Files:**
- Modify: `apps/server/src/jobs/loop.ts:12-30` (`startLoop`)
- Test: `apps/server/src/jobs/loop.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `startLoop(opts)` returns `{ stop(): void; whenIdle(): Promise<void> }`. Task 6 awaits `whenIdle()`.

- [ ] **Step 1: Write the failing tests**

Append to `describe("startLoop", ...)` in `apps/server/src/jobs/loop.test.ts`:

```ts
  it("whenIdle resolves only after the in-flight tick settles", async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(() => new Promise<number>((r) => {
      release = () => r(0);
    }));
    const handle = startLoop({ tick, intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 10)); // a tick is now in flight
    handle.stop();

    let settled = false;
    const idle = handle.whenIdle().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // still waiting on the tick

    release();
    await idle;
    expect(settled).toBe(true);
  });

  it("whenIdle resolves immediately when no tick is running", async () => {
    const handle = startLoop({ tick: () => Promise.resolve(0), intervalMs: 10_000 });
    handle.stop();
    await expect(handle.whenIdle()).resolves.toBeUndefined();
  });

  it("whenIdle resolves even when the in-flight tick rejects", async () => {
    const tick = vi.fn(() => Promise.reject(new Error("drain blew up")));
    const handle = startLoop({ tick, intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    handle.stop();
    await expect(handle.whenIdle()).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @schrodump/server test -- loop.test.ts`
Expected: FAIL — `whenIdle` does not exist on the handle.

- [ ] **Step 3: Implement `whenIdle`**

Replace `startLoop`'s body in `apps/server/src/jobs/loop.ts`:

```ts
// Runs `tick` on an interval. Re-entrancy guarded so a slow tick never overlaps the next one.
// stop() halts further ticks; an in-flight tick finishes on its own — whenIdle() is how a caller
// (the shutdown sequence) waits for it. Shared by the worker drain and the scheduler dispatch —
// both are "run this async work on an interval, single-flight".
export function startLoop(opts: StartLoopOpts): { stop(): void; whenIdle(): Promise<void> } {
  let stopped = false;
  // The in-flight tick, or null when idle. Doubles as the re-entrancy guard the boolean used to be.
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight !== null || stopped) return;
    inFlight = Promise.resolve(opts.tick())
      .then(
        () => undefined,
        () => undefined, // a tick's own failure is the tick's business; the loop keeps its shape
      )
      .finally(() => {
        inFlight = null;
      });
  }, opts.intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    // Resolves when no tick is running. Never rejects: a tick that threw is still a tick that
    // finished, and shutdown must not be derailed by the failure of the work it is waiting out.
    whenIdle() {
      return inFlight ?? Promise.resolve();
    },
  };
}
```

Note: the returned promise is the `.finally(...)` chain, so awaiting it also guarantees `inFlight` has been reset.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @schrodump/server test -- loop.test.ts`
Expected: PASS, including the two pre-existing tests (`runs the tick on each interval and stops cleanly`, `never overlaps ticks`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/jobs/loop.ts apps/server/src/jobs/loop.test.ts
git commit -m "feat(server): expose whenIdle so shutdown can await an in-flight tick"
```

---

### Task 6: The shutdown sequence

**Files:**
- Modify: `apps/server/src/env.ts:6-24` (`EnvSchema`)
- Modify: `apps/server/src/server.ts:110-150` (worker boot and `installShutdown`)
- Test: `apps/server/src/env.test.ts`

**Interfaces:**
- Consumes: `WorkerDeps.signal` (Task 3), `handle.whenIdle()` (Task 5).
- Produces: `Env["SCHRODUMP_SHUTDOWN_GRACE_MS"]: number`. Nothing later depends on it.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/env.test.ts`, inside the existing `describe("loadEnv worker config", ...)` block. It already has a module-level `const base = { DATABASE_URL: "postgres://x", SCHRODUMP_KEK: "k" };` and casts to `NodeJS.ProcessEnv` — follow that exactly:

```ts
  it("defaults the shutdown grace to 8000ms and accepts an override", () => {
    expect(loadEnv({ ...base } as NodeJS.ProcessEnv).SCHRODUMP_SHUTDOWN_GRACE_MS).toBe(8000);
    expect(
      loadEnv({ ...base, SCHRODUMP_SHUTDOWN_GRACE_MS: "2500" } as NodeJS.ProcessEnv)
        .SCHRODUMP_SHUTDOWN_GRACE_MS,
    ).toBe(2500);
  });

  it("rejects a non-positive shutdown grace", () => {
    expect(() =>
      loadEnv({ ...base, SCHRODUMP_SHUTDOWN_GRACE_MS: "0" } as NodeJS.ProcessEnv),
    ).toThrow();
  });
```

You may instead extend the existing `applies defaults when the worker vars are absent` test with the 8000 assertion — but keep the positive-int rejection as its own test.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @schrodump/server test -- env.test.ts`
Expected: FAIL — the key does not exist, so the first assertion gets `undefined`.

- [ ] **Step 3: Add the env var**

In `apps/server/src/env.ts`, after `SCHRODUMP_SCHEDULER_TICK_MS`:

```ts
  // Bounds how long SIGTERM waits for the aborted job's cleanup. Kept under docker's default 10s
  // stop timeout: the abort force-kills the container, so cleanup is normally sub-second, and this
  // exists only so a wedged daemon call cannot hold the process past the stop window.
  SCHRODUMP_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(8000),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @schrodump/server test -- env.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the controller and the sequence in `server.ts`**

Immediately before `const store = createWorkerStore(prisma);` (the "2. Single-flight worker" block):

```ts
  // Process-wide cancellation for the worker. Tripped by SIGTERM below; every container the
  // executor starts carries this signal, so aborting it kills them and releases their scratch.
  const shutdownController = new AbortController();
```

Change the `workerDeps` line to carry it:

```ts
  const workerDeps = {
    store,
    executor,
    log: logger,
    sanitizeReason,
    signal: shutdownController.signal,
  };
```

Replace the whole `installShutdown({...})` call (comment block included) with:

```ts
  // 4. Graceful shutdown: abort the in-flight job and clean up, rather than wait for it. A logical
  //    dump takes minutes to hours and `docker stop` gives ~10s, so draining is not on the table.
  //    An unfinished backup is a FAILED job and an UNOBSERVED artifact — consistent with the thesis
  //    — and, crucially, no cleartext dump survives the shutdown. The abort rides paths that already
  //    exist: the runner kills the container, the executor's finally releases the scratch
  //    reservation, and runWorkerOnce's catch marks the job FAILED. Boot-time orphan recovery and
  //    the scratch sweep remain the backstop for a SIGKILL that beats the grace.
  installShutdown({
    onSignal: async () => {
      handle.stop();
      schedulerHandle.stop();
      shutdownController.abort();
      const graceMs = env.SCHRODUMP_SHUTDOWN_GRACE_MS;
      const timedOut = await Promise.race([
        handle.whenIdle().then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs).unref()),
      ]);
      if (timedOut) {
        // The cleanup is wedged (most likely a hung Docker daemon call). Exit anyway — holding the
        // process past the docker-stop window only trades this for a SIGKILL, and the boot sweep
        // recovers either way.
        logger.warn({ graceMs }, "shutdown grace expired with a job still cleaning up");
      }
      await advisoryLockPrisma.$disconnect();
    },
  });
```

Note `.unref()` on the grace timer: it must never be the reason the event loop stays alive.

- [ ] **Step 6: Verify the whole workspace**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/env.ts apps/server/src/env.test.ts apps/server/src/server.ts
git commit -m "feat(server): abort the in-flight job on SIGTERM and await its cleanup"
```

---

### Task 7: Deploy surface and documentation

**Files:**
- Modify: `compose.yaml` (the `schrodump` service)
- Modify: `docker/entrypoint.sh:32-34` (the stale NOTE)
- Modify: `packages/runner/CLAUDE.md:34-38` ("Gap conhecido")
- Modify: `docs/roadmap.md` (the known-limitations row `No SIGTERM handler…`)
- Modify: `docs/security.md:68-72` (the "Known limitation" block)

**Interfaces:**
- Consumes: `SCHRODUMP_SHUTDOWN_GRACE_MS` (Task 6).
- Produces: nothing consumed by code.

- [ ] **Step 1: Give the container room to shut down**

In `compose.yaml`, in the `schrodump` service, add after `restart: unless-stopped`:

```yaml
    # A margin over SCHRODUMP_SHUTDOWN_GRACE_MS (8s default). The abort itself is sub-second; this
    # only guarantees docker does not SIGKILL while the cleanup is still running.
    stop_grace_period: 15s
```

- [ ] **Step 2: Correct the entrypoint NOTE**

In `docker/entrypoint.sh`, replace the three-line `# NOTE:` block above `stop()` with:

```sh
# NOTE: the API installs a SIGTERM/SIGINT handler. It aborts the in-flight job — the executor
# container is killed and its scratch directory (holding the dump in clear) is removed — within
# SCHRODUMP_SHUTDOWN_GRACE_MS, then exits. A SIGKILL that beats that window still leaves scratch
# for the ScratchManager sweep on the next boot.
```

- [ ] **Step 3: Flip the runner's "Gap conhecido"**

In `packages/runner/CLAUDE.md`, replace the `> **Gap conhecido:** …` block (lines 34-38) with:

```markdown
> **Cancelamento no shutdown:** `RunOptions.signal` e o terceiro parâmetro de
> `withEphemeralService` recebem um `AbortSignal`. No abort o runner mata o container pelo **mesmo
> caminho que o timeout já usa**, a `run()` rejeita com `RUNNER_ABORTED`, e o `finally` do executor
> libera a reserva de scratch — o dump em claro não sobrevive ao `docker stop`. O handler que
> dispara o abort vive no server (`server.ts`), limitado por `SCHRODUMP_SHUTDOWN_GRACE_MS`.
> Resíduo: um `SIGKILL` antes da grace ainda depende da varredura do próximo boot.
```

- [ ] **Step 4: Update the roadmap row**

In `docs/roadmap.md`, in the "Known limitations shipping in v1" table, replace the row whose first cell is ``No `SIGTERM` handler in the server or runner`` with:

```markdown
| A `SIGKILL` that beats `SCHRODUMP_SHUTDOWN_GRACE_MS` still leaves scratch behind                   | `SIGTERM` now aborts the in-flight job: the executor container is killed, the scratch directory (holding the dump in clear) is removed, and the job row is `FAILED` before the process exits — bounded by `SCHRODUMP_SHUTDOWN_GRACE_MS` (default 8s, under docker's 10s). What remains is the pathological path: a `SIGKILL` before the grace expires, or a wedged Docker daemon, still relies on the boot-time scratch sweep and orphan recovery. No worse than before; the normal path is now fully cleaned at shutdown. |
```

- [ ] **Step 5: Update the security doc**

In `docs/security.md`, replace the `> **Known limitation.** …` block (lines 68-72) with:

```markdown
> **Cleanup on the way out.** A `SIGTERM` (what `docker stop` sends) aborts the in-flight job: the
> executor container is killed and its scratch directory — which holds the dump **in clear** — is
> removed before the process exits, inside `SCHRODUMP_SHUTDOWN_GRACE_MS` (default 8s). The residual
> window is narrower but not zero: a `SIGKILL` that beats the grace, or a Docker daemon that hangs
> during teardown, still leaves the directory for the `ScratchManager` sweep on the next boot.
```

- [ ] **Step 6: Verify nothing is stale**

Run: `grep -rn "SIGTERM" docs/ packages/*/CLAUDE.md docker/ compose.yaml`
Expected: every remaining mention describes the handler as **present**. No prose should still claim no handler exists.

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: clean (docs-only changes, but the gate is cheap).

- [ ] **Step 7: Commit**

```bash
git add compose.yaml docker/entrypoint.sh packages/runner/CLAUDE.md docs/roadmap.md docs/security.md
git commit -m "docs: SIGTERM abort-and-clean is shipped, with its honest residual"
```

---

## Manual smoke (not a CI gate)

The spec is explicit that a real-container SIGTERM harness is disproportionate. Do this by hand once, on a dev stack, and write what you saw into the PR body:

1. Start the stack, trigger a backup against a target large enough to still be dumping after ~10s.
2. While the job is `RUNNING`: `docker stop <schrodump container>`.
3. Assert, in order:
   - `docker ps -a` shows **no** executor container for that job.
   - The scratch volume holds **no** directory for that job id (no cleartext dump).
   - The `BackupJob` row is `FAILED` with a reason naming the shutdown abort.
   - `docker stop` returned without needing its `SIGKILL` fallback.

## Self-review notes

- **Spec coverage.** Runner cancellation → Tasks 1-2. Worker/executor threading → Tasks 3-4. `whenIdle` + shutdown orchestration → Tasks 5-6. Config and compose → Task 6-7. Docs → Task 7. Testing section → the unit tests in Tasks 1, 2, 3, 5, 6, plus the classification lock in Task 4 and the manual smoke above.
- **Beyond the spec.** The `runWorkerOnce` claim guard (Task 3) closes a gap the spec did not name: `handle.stop()` does not interrupt the running `drainQueue`, which would otherwise claim the next job mid-shutdown. Without it the change would make the worst case worse, not better.
- **Names used consistently across tasks:** `RunOptions.signal`, `abortedError()`, `RUNNER_ABORTED`, `WorkerDeps.signal`, `whenIdle()`, `SCHRODUMP_SHUTDOWN_GRACE_MS`, `shutdownController`.
- **Out of scope, per the spec:** the Next process, draining to completion, resumable dumps, and a per-job cancel button (which this plumbing makes cheap later).
