# SIGTERM graceful shutdown (abort + clean) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `SIGTERM`/`SIGINT`, abort the in-flight worker job — tear down its executor container and release its scratch reservation (the cleartext dump) at shutdown — instead of leaking both until the next-boot sweep.

**Architecture:** One process-wide `AbortController` is tripped by the signal handler. Its `signal` is bound into the `JobExecutor` at construction and flows into every container-creating runner call (`run` + `withEphemeralService`). On abort the runner force-kills the container (reusing the timeout kill path); the `run()` promise rejects, the executor's existing `finally` removes the scratch dir, and `runWorkerOnce`'s existing `catch` marks the job `FAILED`. The shutdown handler awaits the in-flight tick to settle, bounded by a grace timeout; boot orphan-recovery + scratch sweep remain the backstop.

**Tech Stack:** TypeScript ESM (nodenext), Node 22 `AbortSignal`/`AbortController` (no new deps), Vitest, dockerode.

## Global Constraints

- **SPDX header** on every source file created (`// SPDX-License-Identifier: AGPL-3.0-or-later` + `// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA`).
- **Dependency graph:** `packages/runner` imports only `@schrodump/core`. `AbortSignal` is a global (lib.dom / Node global) — no import needed, no cross-package dependency introduced.
- **`verbatimModuleSyntax`:** import types with `import type`.
- **No new drain-to-completion, no resource registry.** Abort rides the executor's existing cleanup + failure paths (per the approved spec).
- **`worker.ts` (the worker brain) does NOT change** — the signal is bound into the executor at construction, not threaded through `drainQueue`/`runWorkerOnce`.
- **No secrets in logs.** The shutdown reason string is a fixed literal, never a driver message.
- **Commits:** Conventional Commits, English title, no attribution of any kind.
- Design reference: `docs/superpowers/specs/2026-07-25-sigterm-graceful-shutdown-design.md`.

---

## File Structure

- `packages/runner/src/runner.ts` — `RunOptions.signal?`; `withEphemeralService` optional `opts.signal`.
- `packages/runner/src/docker.ts` — honor the signal in `run()` and `withEphemeralService()`.
- `packages/runner/src/docker.test.ts` — cancellation tests (fake engine).
- `apps/server/src/jobs/loop.ts` — `startLoop` exposes `whenIdle()`.
- `apps/server/src/jobs/loop.test.ts` — `whenIdle()` tests.
- `apps/server/src/jobs/shutdown.ts` (new) — pure `runGracefulShutdown()` orchestration helper.
- `apps/server/src/jobs/shutdown.test.ts` (new) — orchestration tests (fake timers).
- `apps/server/src/jobs/worker-wiring.ts` — `createJobExecutor` accepts `signal`; forwards into its `run`/`withEphemeralService` calls and into the backup/restore ports.
- `apps/server/src/jobs/backup-wiring.ts` — `BackupWiringDeps.signal?`; `run` opts gets `signal`.
- `apps/server/src/jobs/restore-executor.ts` — restore deps `signal?`; `run` opts gets `signal`.
- `apps/server/src/env.ts` — `SCHRODUMP_SHUTDOWN_GRACE_MS`.
- `apps/server/src/server.ts` — create the controller, bind it into the executor, wire `runGracefulShutdown` into `installShutdown`.
- `compose.yaml` — `stop_grace_period: 15s`.
- `docker/entrypoint.sh`, `packages/runner/CLAUDE.md`, `docs/roadmap.md`, `docs/security.md` — flip the "no SIGTERM handler" note to shipped.

---

### Task 1: Runner honors an AbortSignal (force-kill container on abort)

**Files:**
- Modify: `packages/runner/src/runner.ts`
- Modify: `packages/runner/src/docker.ts:64-182`
- Test: `packages/runner/src/docker.test.ts`

**Interfaces:**
- Consumes: existing `DockerEngine`/`StartedContainer` (`kill()`, `remove()` already present).
- Produces: `RunOptions.signal?: AbortSignal`; `withEphemeralService(spec, use, opts?: { signal?: AbortSignal })`; a `RUNNER_ABORTED` `SchrodumpError` code emitted when a run is cancelled.

- [ ] **Step 1: Write the failing tests**

Add to `packages/runner/src/docker.test.ts` (follow the file's existing fake-engine harness — reuse whatever `DockerEngine` fake the neighbouring tests use; the snippet below shows intent, adapt to the existing helpers):

```ts
describe("run() cancellation", () => {
  it("force-kills the container and rejects when the signal aborts mid-run", async () => {
    const controller = new AbortController();
    const { engine, container } = fakeEngineWithHangingWait(); // wait() never resolves on its own
    const runner = new DockerRunner(engine);
    const p = runner.run(descriptor, { ...baseOpts, signal: controller.signal });
    controller.abort(new Error("shutdown"));
    await expect(p).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(container.kill).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledTimes(1); // finally still reaps
  });

  it("never starts a container when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("shutdown"));
    const { engine, startSpy } = fakeEngine();
    const runner = new DockerRunner(engine);
    const sink = new PassThrough();
    await expect(
      runner.run(descriptor, { ...baseOpts, stdout: sink, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(startSpy).not.toHaveBeenCalled();
    expect(sink.writableEnded).toBe(true); // endStdout unblocked any downstream consumer
  });

  it("tears the ephemeral service down when the signal aborts during readiness", async () => {
    const controller = new AbortController();
    const { engine, service } = fakeServiceNeverReady();
    const runner = new DockerRunner(engine);
    const p = runner.withEphemeralService(serviceSpec, async () => "unused", {
      signal: controller.signal,
    });
    controller.abort(new Error("shutdown"));
    await expect(p).rejects.toBeDefined();
    expect(service.remove).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @schrodump/runner test -- docker.test.ts`
Expected: FAIL — `signal` not accepted / no `RUNNER_ABORTED`.

- [ ] **Step 3: Add `signal` to the runner types**

In `packages/runner/src/runner.ts`, add to `RunOptions` (after `correlationId`):

```ts
  // When aborted, the runner force-removes the container and rejects with RUNNER_ABORTED. Used by
  // the server's SIGTERM handler to cancel an in-flight job so no cleartext dump outlives shutdown.
  readonly signal?: AbortSignal;
```

Change the `Runner` interface + `withEphemeralService` signature to accept an optional opts:

```ts
  withEphemeralService<T>(
    spec: EphemeralServiceSpec,
    use: (handle: EphemeralServiceHandle) => Promise<T>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<T>;
```

- [ ] **Step 4: Honor the signal in `docker.ts` `run()`**

At the top of `run()` (before the network check at `:68`), short-circuit an already-aborted signal — end the caller's sink so a downstream consumer unblocks, exactly as the other pre-stream failure paths do:

```ts
    if (opts.signal?.aborted === true) {
      endStdout(opts.stdout);
      throw abortedError(opts.correlationId);
    }
```

In the `try` block that races `execution` against `timeout` (`:109-135`), add a third racer and clean its listener up in a local `finally`. Add alongside the `timeout` promise:

```ts
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        const signal = opts.signal;
        if (signal === undefined) return; // never settles → never wins the race
        onAbort = () => {
          // Same teardown the timeout uses: kill now; the finally below force-removes.
          void container.kill().catch(() => undefined);
          reject(abortedError(opts.correlationId));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });

      const exitCode = await Promise.race([execution, timeout, aborted]);
```

Remove the abort listener in the existing `finally` (`:150`), before/after the `clearTimeout`:

```ts
      if (onAbort !== undefined) opts.signal?.removeEventListener("abort", onAbort);
```

Add the helper near the other error constructors in `docker.ts`:

```ts
function abortedError(correlationId: string): SchrodumpError {
  return new SchrodumpError("run aborted by shutdown", {
    code: "RUNNER_ABORTED",
    correlationId,
    context: {},
  });
}
```

- [ ] **Step 5: Honor the signal in `withEphemeralService()`**

Accept the new `opts` param. Short-circuit an already-aborted signal before `startService` (after the network check at `:170`):

```ts
    if (opts?.signal?.aborted === true) {
      throw abortedError(spec.correlationId);
    }
```

Thread the signal into `#waitUntilReady` so readiness polling bails fast on abort instead of waiting out `readinessTimeoutMs`. Change the loop to check between polls:

```ts
  async #waitUntilReady(svc: StartedService, spec: EphemeralServiceSpec, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + spec.readinessTimeoutMs;
    for (;;) {
      if (signal?.aborted === true) throw abortedError(spec.correlationId);
      const exitCode = await svc.exec(spec.readinessCommand);
      if (exitCode === 0) return;
      // ... unchanged deadline/sleep logic ...
    }
  }
```

Pass `opts?.signal` at the `#waitUntilReady(svc, spec)` call. The `finally` at `:180` already force-removes the service, so an abort during `use` (whose inner `run` calls carry the same signal and reject) or during readiness always reaps the container. Update the class method signature to `withEphemeralService<T>(spec, use, opts?: { readonly signal?: AbortSignal })`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @schrodump/runner test -- docker.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter @schrodump/runner typecheck`
```bash
git add packages/runner/src/runner.ts packages/runner/src/docker.ts packages/runner/src/docker.test.ts
git commit -m "feat(runner): cancel an in-flight run via an AbortSignal"
```

---

### Task 2: `startLoop` exposes an awaitable `whenIdle()`

**Files:**
- Modify: `apps/server/src/jobs/loop.ts:13-31`
- Test: `apps/server/src/jobs/loop.test.ts`

**Interfaces:**
- Produces: `startLoop(...)` returns `{ stop(): void; whenIdle(): Promise<void> }`. `whenIdle()` resolves when no tick is in flight (immediately if idle; after the current tick settles otherwise). `installShutdown`/`ShutdownHandlers` are unchanged in this task.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/jobs/loop.test.ts`:

```ts
it("whenIdle() resolves only after an in-flight tick settles", async () => {
  let release!: () => void;
  const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
  const loop = startLoop({ tick, intervalMs: 1 });
  await vi.advanceTimersByTimeAsync(1); // let one tick start
  let resolved = false;
  const idle = loop.whenIdle().then(() => (resolved = true));
  await Promise.resolve();
  expect(resolved).toBe(false); // tick still running
  release();
  await idle;
  expect(resolved).toBe(true);
  loop.stop();
});

it("whenIdle() resolves immediately when no tick is running", async () => {
  const loop = startLoop({ tick: vi.fn(async () => {}), intervalMs: 10_000 });
  await expect(loop.whenIdle()).resolves.toBeUndefined();
  loop.stop();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @schrodump/server test -- loop.test.ts`
Expected: FAIL — `whenIdle` is not a function.

- [ ] **Step 3: Track the in-flight tick and expose `whenIdle()`**

Rewrite `startLoop` to hold the in-flight tick promise:

```ts
export function startLoop(opts: StartLoopOpts): { stop(): void; whenIdle(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (inFlight !== null || stopped) return;
    inFlight = Promise.resolve(opts.tick())
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  }, opts.intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    // Resolves when no tick is in flight. stop() first, then whenIdle(), to await a running tick
    // without a new one starting behind it.
    whenIdle() {
      return Promise.resolve(inFlight ?? undefined).then(() => undefined);
    },
  };
}
```

(Behavior is identical to the old `running` boolean; `inFlight` doubles as the guard and the awaitable.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @schrodump/server test -- loop.test.ts`
Expected: PASS. Also run the full loop suite to confirm no regression in existing tick tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/jobs/loop.ts apps/server/src/jobs/loop.test.ts
git commit -m "feat(server): make startLoop's in-flight tick awaitable via whenIdle"
```

---

### Task 3: Bind the shutdown signal into the executor and forward it to every run

**Files:**
- Modify: `apps/server/src/jobs/worker-wiring.ts` (`createJobExecutor` + its `run`/`withEphemeralService` calls at `:666`, `:749`)
- Modify: `apps/server/src/jobs/backup-wiring.ts:59-77` (`createBackupPorts` / `BackupWiringDeps`)
- Modify: `apps/server/src/jobs/restore-executor.ts:340-345` (restore deps + run opts)
- Test: the existing `worker-wiring` / `backup-wiring` / `restore-executor` unit tests (add a forwarding assertion)

**Interfaces:**
- Consumes: `RunOptions.signal` (Task 1).
- Produces: `createJobExecutor(deps)` accepts `deps.signal?: AbortSignal` and forwards it into every container-creating call it makes, directly and through the backup/restore ports.

- [ ] **Step 1: Write the failing test**

In the backup-wiring unit test (fake runner that captures the opts it is called with), assert the signal is forwarded:

```ts
it("forwards the shutdown signal into the runner run options", async () => {
  const controller = new AbortController();
  const captured: RunOptions[] = [];
  const runner = { run: vi.fn((_d, opts) => { captured.push(opts); return neverResolving(); }), withEphemeralService: vi.fn() };
  const ports = createBackupPorts({ ...baseDeps, runner, signal: controller.signal });
  void ports./* the method that calls uploadEncrypted */(/* ... */);
  await Promise.resolve();
  expect(captured[0]?.signal).toBe(controller.signal);
});
```

Adapt to how the existing backup-wiring test drives `uploadEncrypted` (it already has a fake runner — extend it rather than inventing a new harness). Add the analogous assertion in the restore-executor test.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @schrodump/server test -- backup-wiring`
Expected: FAIL — `signal` not on deps / not forwarded.

- [ ] **Step 3: Thread the signal through the ports**

`backup-wiring.ts`: add `readonly signal?: AbortSignal;` to `BackupWiringDeps`, and add `signal: deps.signal,` to the `deps.runner.run(descriptor, { ... })` opts at `:69-77`.

`restore-executor.ts`: add `signal?: AbortSignal` to the restore-executor deps type, and add `signal: deps.signal,` to the `deps.runner.run(...)` opts at `:340-345`.

`worker-wiring.ts` `createJobExecutor`: add `signal?: AbortSignal` to its deps/params. Forward it:
- into `createBackupPorts({ ..., signal })`,
- into the restore-executor deps it builds,
- into its own `runner.run(...)` verify-assert call (`:749`) as `signal: deps.signal`,
- into `runner.withEphemeralService(spec, use, { signal: deps.signal })` (`:666`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @schrodump/server test -- backup-wiring restore-executor worker-wiring`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/jobs/worker-wiring.ts apps/server/src/jobs/backup-wiring.ts apps/server/src/jobs/restore-executor.ts apps/server/src/jobs/*.test.ts
git commit -m "feat(server): forward a shutdown AbortSignal to every executor run"
```

---

### Task 4: The shutdown sequence — grace env, orchestration, wiring, compose, docs

**Files:**
- Modify: `apps/server/src/env.ts:6-24`
- Create: `apps/server/src/jobs/shutdown.ts`
- Create: `apps/server/src/jobs/shutdown.test.ts`
- Modify: `apps/server/src/server.ts:110-151`
- Modify: `compose.yaml:4-6`
- Modify: `docker/entrypoint.sh:32-34`, `packages/runner/CLAUDE.md`, `docs/roadmap.md`, `docs/security.md`

**Interfaces:**
- Consumes: `startLoop(...).whenIdle()` (Task 2), the executor's bound signal (Task 3), `env.SCHRODUMP_SHUTDOWN_GRACE_MS`.
- Produces: `runGracefulShutdown(deps): Promise<void>` — stops the loops, aborts, awaits idle under the grace, disconnects. Pure/injectable for unit test.

- [ ] **Step 1: Add the grace env var**

`env.ts`, in `EnvSchema` after `SCHRODUMP_SCHEDULER_TICK_MS`:

```ts
  // Bounds the awaited drain on SIGTERM. Kept under docker's default 10s stop grace so the abort +
  // scratch cleanup finish before SIGKILL. The abort itself is sub-second; this only caps a wedged
  // Docker teardown from holding the process past the window.
  SCHRODUMP_SHUTDOWN_GRACE_MS: z.coerce.number().int().default(8000),
```

- [ ] **Step 2: Write the failing orchestration tests**

Create `apps/server/src/jobs/shutdown.test.ts` (SPDX header). Cover: (a) it calls `stop()` on both handles, then `abort()`, then awaits `whenIdle`; (b) when `whenIdle` outlasts the grace, it proceeds anyway (fake timers); (c) it always `$disconnect`s.

```ts
it("stops loops, aborts, awaits idle, disconnects — in order", async () => {
  const order: string[] = [];
  const controller = { abort: vi.fn(() => order.push("abort")) };
  const handle = { stop: vi.fn(() => order.push("stopWorker")), whenIdle: vi.fn(() => { order.push("whenIdle"); return Promise.resolve(); }) };
  const scheduler = { stop: vi.fn(() => order.push("stopScheduler")) };
  const disconnect = vi.fn(async () => { order.push("disconnect"); });
  await runGracefulShutdown({ handle, scheduler, controller, disconnect, graceMs: 8000, log: fakeLog });
  expect(order).toEqual(["stopWorker", "stopScheduler", "abort", "whenIdle", "disconnect"]);
});

it("proceeds to disconnect when the drain outlasts the grace", async () => {
  vi.useFakeTimers();
  const disconnect = vi.fn(async () => {});
  const p = runGracefulShutdown({
    handle: { stop: vi.fn(), whenIdle: () => new Promise(() => {}) }, // never idle
    scheduler: { stop: vi.fn() },
    controller: { abort: vi.fn() },
    disconnect, graceMs: 8000, log: fakeLog,
  });
  await vi.advanceTimersByTimeAsync(8000);
  await p;
  expect(disconnect).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @schrodump/server test -- shutdown.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `runGracefulShutdown`**

Create `apps/server/src/jobs/shutdown.ts` (SPDX header):

```ts
export interface GracefulShutdownDeps {
  handle: { stop(): void; whenIdle(): Promise<void> };
  scheduler: { stop(): void };
  controller: { abort(reason?: unknown): void };
  disconnect(): Promise<void>;
  graceMs: number;
  log: { info(obj: Record<string, unknown>, msg: string): void };
}

// Ordered shutdown: stop claiming, abort the in-flight run (the runner force-kills its container →
// run() rejects → executor finally releases the scratch dir → runWorkerOnce marks the job FAILED),
// await the tick settling but never past graceMs, then drop the advisory-lock connection. A drain
// that outlasts the grace falls through to the boot-time backstop (orphan recovery + scratch sweep).
export async function runGracefulShutdown(deps: GracefulShutdownDeps): Promise<void> {
  deps.log.info({}, "shutdown: stopping loops");
  deps.handle.stop();
  deps.scheduler.stop();
  deps.controller.abort(new Error("shutdown"));
  // Clear the grace timer when whenIdle() wins, so a resolved shutdown never leaves an 8s timer
  // pending (which would keep the event loop alive and delay a clean exit).
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, deps.graceMs);
  });
  await Promise.race([deps.handle.whenIdle(), grace]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  await deps.disconnect();
  deps.log.info({}, "shutdown: complete");
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @schrodump/server test -- shutdown.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire it into `server.ts`**

In `main()` at the worker boot: create the controller and bind its signal into the executor.

```ts
  const shutdownController = new AbortController();
  const executor = createJobExecutor({ prisma, kek, env, signal: shutdownController.signal });
```

Replace the `installShutdown({ onSignal: ... })` body (`:144-150`) with a call to the helper:

```ts
  installShutdown({
    onSignal: () =>
      runGracefulShutdown({
        handle,
        scheduler: schedulerHandle,
        controller: shutdownController,
        disconnect: () => advisoryLockPrisma.$disconnect(),
        graceMs: env.SCHRODUMP_SHUTDOWN_GRACE_MS,
        log: logger,
      }),
  });
```

Add the `runGracefulShutdown` import. Remove the now-inaccurate inline comment at `:141-143` (its "full mid-dump cancel is the runner's timeout path" claim is superseded).

- [ ] **Step 7: Run the full server suite + typecheck**

Run: `pnpm --filter @schrodump/server test` then `pnpm --filter @schrodump/server typecheck`
Expected: PASS (no regressions).

- [ ] **Step 8: compose + docs**

`compose.yaml`: under the `schrodump` service (after `restart: unless-stopped`):

```yaml
    # Give the server time to abort an in-flight job and remove its scratch (cleartext dump) before
    # SIGKILL. Matches SCHRODUMP_SHUTDOWN_GRACE_MS (8s) with margin.
    stop_grace_period: 15s
```

`docker/entrypoint.sh:32-34`: replace the stale NOTE — the API now installs a SIGTERM handler that aborts the in-flight job and clears its scratch before exit; the shell trap still forwards the signal.

`packages/runner/CLAUDE.md` ("Gap conhecido" block) and `docs/roadmap.md` ("No `SIGTERM` handler…" row): flip from gap to shipped — describe abort-and-clean and the residual (a `SIGKILL` before grace still relies on the boot sweep). `docs/security.md`: update the cleartext-window note to say the scratch dir is removed at shutdown in the normal path.

- [ ] **Step 9: Full workspace verification + commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.
```bash
git add apps/server/src/env.ts apps/server/src/jobs/shutdown.ts apps/server/src/jobs/shutdown.test.ts apps/server/src/server.ts compose.yaml docker/entrypoint.sh packages/runner/CLAUDE.md docs/roadmap.md docs/security.md
git commit -m "feat(server): install a SIGTERM handler that aborts the in-flight job and clears scratch"
```

---

## Notes for the executor

- **`worker.ts` must stay untouched** — if you find yourself editing `drainQueue`/`runWorkerOnce`, stop: the signal is bound into the executor at construction (Task 3), not threaded through the brain.
- The real end-to-end `SIGTERM`-mid-dump behavior (container gone, scratch gone, job `FAILED`) is a manual/dev smoke, not a CI gate — do not add a real-container SIGTERM integration test.
- Reuse each file's existing test harness/fakes; do not introduce a parallel fake-runner or fake-engine when one already exists in the suite.
