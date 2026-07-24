# FULL_RESTORE verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `FULL_RESTORE` verify from a stub into a real proof — restore the artifact into an ephemeral, isolated PostgreSQL container, assert the schema is present, then destroy it — reusing the shipped restore pipeline.

**Architecture:** A new runner capability (`withEphemeralService`) provisions the sandbox; the engine adapter describes it (`buildVerifySandbox`); `runFullRestore` composes `withEphemeralService` + `runRestorePipeline` + `buildVerifyAssertions`; the domain gains a three-way `VerifyProof` so an infra failure leaves the artifact `UNOBSERVED` instead of `FAILED`. PostgreSQL only; non-postgres and sealed downgrade to `CHECKSUM` (visible).

**Tech Stack:** Node 22, TypeScript ESM (nodenext), Vitest, dockerode, Fastify, Prisma. See `docs/superpowers/specs/2026-07-24-full-restore-verify-design.md`.

## Global Constraints

- **SPDX header** on every new/edited source file: `// SPDX-License-Identifier: AGPL-3.0-or-later` + `// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA`.
- **Dependency graph:** `packages/runner` and `packages/engines` import ONLY `@schrodump/core`, never each other or `apps/*`. `apps/server` composes them.
- **No secret in logs, responses, or `BackupJob.reason`** (any level). Error messages stay credential-free. The sandbox password is a `randomUUID()` throwaway.
- **Success is `exitCode === 0`, never inferred from EOF.** A failed/inconclusive verify must never mark a good artifact `FAILED`.
- **Runner owns Docker.** `apps/server` never imports dockerode; it composes runner methods.
- **Verify is the sole authority over an artifact's final state** (`VERIFIED`/`FAILED`); an untested artifact stays `UNOBSERVED`.
- Verify commands: `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit; integration is `describe.skipIf` unless `SCHRODUMP_TEST_INTEGRATION=1`), `pnpm build`.

---

### Task 1: Runner `withEphemeralService`

**Files:**
- Modify: `packages/runner/src/runner.ts` (add types + interface method)
- Modify: `packages/runner/src/docker.ts` (impl + `DockerEngine.startService` + `StartedService`)
- Test: `packages/runner/src/docker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EphemeralServiceSpec {
    readonly image: string;
    readonly env: Record<string, string>;
    readonly network: string;
    readonly readinessCommand: string[]; // exec'd; exit 0 = ready
    readonly port: number;               // in-container listen port
    readonly correlationId: string;
    readonly readinessTimeoutMs: number; // bounds readiness polling
  }
  export interface EphemeralServiceHandle { readonly host: string; readonly port: number; }
  // on Runner:
  withEphemeralService<T>(spec: EphemeralServiceSpec, use: (h: EphemeralServiceHandle) => Promise<T>): Promise<T>;
  ```
- Consumes: `SchrodumpError` from `@schrodump/core/errors`.

- [ ] **Step 1: Extend the `DockerEngine` seam.** In `docker.ts`, add to the `DockerEngine` interface a `startService(spec: EphemeralServiceSpec): Promise<StartedService>` and the type:
  ```ts
  export interface StartedService {
    readonly host: string;            // in-network address of the container
    exec(command: string[]): Promise<number>; // runs command in the container, returns exit code
    remove(): Promise<void>;          // force-remove
  }
  ```

- [ ] **Step 2: Write the failing test (fake engine).** In `docker.test.ts`, extend the `FakeEngine` to implement `startService` returning a fake `StartedService` whose `exec` returns 0 only after `readyAfter` calls (configurable), records `removed`. Tests:
  ```ts
  it("withEphemeralService calls use with the address once ready, then removes the container", async () => {
    const engine = new FakeEngine({ readyAfter: 2 });
    const seen = await new DockerRunner(engine).withEphemeralService(SERVICE_SPEC, async (h) => h.host);
    expect(seen).toBe(engine.lastServiceHost);
    expect(engine.serviceRemoved).toBe(true);
    expect(engine.execCalls).toBeGreaterThanOrEqual(2);
  });
  it("throws RUNNER_SERVICE_NOT_READY and still removes when readiness never succeeds", async () => {
    const engine = new FakeEngine({ readyAfter: Infinity });
    await expect(new DockerRunner(engine).withEphemeralService({ ...SERVICE_SPEC, readinessTimeoutMs: 50 }, async () => "x"))
      .rejects.toMatchObject({ code: "RUNNER_SERVICE_NOT_READY" });
    expect(engine.serviceRemoved).toBe(true);
  });
  it("removes the container even when use throws", async () => {
    const engine = new FakeEngine({ readyAfter: 1 });
    await expect(new DockerRunner(engine).withEphemeralService(SERVICE_SPEC, async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
    expect(engine.serviceRemoved).toBe(true);
  });
  ```
  Use a small poll interval in the impl (see Step 4) or make it injectable so `readinessTimeoutMs: 50` resolves fast. `SERVICE_SPEC` is a minimal `EphemeralServiceSpec` with `readinessTimeoutMs: 1000`.

- [ ] **Step 3: Run the tests — verify they fail** (`withEphemeralService` not defined). `pnpm --filter @schrodump/runner test`.

- [ ] **Step 4: Implement `withEphemeralService` on `DockerRunner`.** Poll `exec(readinessCommand)` every `POLL_MS` (≈250ms) until it returns 0 or the elapsed time exceeds `spec.readinessTimeoutMs`; on timeout throw `new SchrodumpError("service did not become ready", { code: "RUNNER_SERVICE_NOT_READY", correlationId: spec.correlationId, context: { image: spec.image } })`. On ready, call `use({ host: svc.host, port: spec.port })`. Always `await svc.remove().catch(() => undefined)` in `finally`. Use a monotonic elapsed check; do NOT introduce randomness. Keep the readiness poll cancellable by the timeout. (Time via `Date.now()` is allowed here — this is app/runtime code, not a workflow script.)

- [ ] **Step 5: Implement `DockerodeEngine.startService`.** `createContainer({ Image, Env, HostConfig:{ NetworkMode: spec.network, AutoRemove:false } })`, `start()`, read the in-network address from `container.inspect()` (`NetworkSettings.Networks[spec.network].IPAddress`, else the container name as the alias on that network). `exec(command)` via `container.exec({ Cmd, AttachStdout:true, AttachStderr:true })` → start → read the exec inspect `ExitCode`. `remove()` → `container.remove({ force: true })`. Mirror the credential/attach conventions already in `start()`.

- [ ] **Step 6: Add the method to the `Runner` interface** in `runner.ts` with the two new exported types. Keep `run` unchanged.

- [ ] **Step 7: Run tests + typecheck + lint.** `pnpm --filter @schrodump/runner test && pnpm --filter @schrodump/runner typecheck && pnpm --filter @schrodump/runner lint`. Expected: green.

- [ ] **Step 8: Commit.** `feat(runner): add withEphemeralService for ephemeral service containers`.

---

### Task 2: Engine `buildVerifySandbox` (postgres)

**Files:**
- Modify: `packages/engines/src/descriptor.ts` (types + optional adapter method)
- Modify: `packages/engines/src/adapters/postgres.ts`
- Test: `packages/engines/src/adapters/postgres.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface VerifySandbox {
    readonly image: string;
    readonly env: Record<string, string>;   // POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
    readonly readinessCommand: string[];     // ["pg_isready","-U",user,"-d",db]
    readonly port: number;                   // 5432
    readonly username: string;
    readonly password: string;
    readonly database: string;
  }
  // optional on EngineAdapter (like buildGlobalsRestore):
  buildVerifySandbox?(serverVersionNum: number, password: string): VerifySandbox;
  ```

- [ ] **Step 1: Write the failing test.**
  ```ts
  describe("postgresAdapter.buildVerifySandbox", () => {
    it("describes a postgres sandbox of the artifact's major with bootstrap creds and readiness", () => {
      const s = postgresAdapter.buildVerifySandbox!(160002, "secret-123");
      expect(s.image).toBe("postgres:16-alpine");
      expect(s.env.POSTGRES_USER).toBe("verify");
      expect(s.env.POSTGRES_PASSWORD).toBe("secret-123");
      expect(s.env.POSTGRES_DB).toBe("verify");
      expect(s.readinessCommand).toEqual(["pg_isready", "-U", "verify", "-d", "verify"]);
      expect(s.port).toBe(5432);
      expect(s.username).toBe("verify");
      expect(s.database).toBe("verify");
      expect(s.password).toBe("secret-123");
    });
  });
  ```

- [ ] **Step 2: Run it — verify it fails.** `pnpm --filter @schrodump/engines test`.

- [ ] **Step 3: Implement `buildVerifySandbox` on `postgresAdapter`,** reusing `this.imageFor(serverVersionNum)`. Fixed `verify`/`verify` identifiers; password from the parameter. Add the type + optional method to `descriptor.ts`.

- [ ] **Step 4: Run tests + typecheck + lint** for engines. Expected: green.

- [ ] **Step 5: Commit.** `feat(engines): describe the postgres FULL_RESTORE verify sandbox`.

---

### Task 3: Typed restore-executor errors

**Files:**
- Modify: `apps/server/src/jobs/restore-executor.ts`

**Interfaces:**
- Produces: the throws in `restoreOne` become `SchrodumpError` with codes `RESTORE_SOURCE_FAILED`, `RESTORE_DECRYPT_FAILED`, `RESTORE_EXECUTOR_FAILED`. Consumed by Task 5's `classifyVerifyError`. Messages stay credential-free (unchanged wording); `runRestoreJob`'s `error.message → reason` path is unaffected.

- [ ] **Step 1: Convert the source-error throw.** The `ciphertext.destroy(new Error("restore source stream failed"))` becomes `ciphertext.destroy(new SchrodumpError("restore source stream failed", { code: "RESTORE_SOURCE_FAILED", correlationId: deps.correlationId }))`.

- [ ] **Step 2: Wrap the decrypt/gunzip pipeline** so a decrypt/gunzip rejection (e.g. zlib "unexpected end of file") is re-thrown as `new SchrodumpError("restore decrypt failed", { code: "RESTORE_DECRYPT_FAILED", correlationId: deps.correlationId, cause: err })`. Do NOT let the raw zlib message become the message (keep it in `cause`). A source error rethrown from the PassThrough already carries `RESTORE_SOURCE_FAILED` — let it pass through unchanged (check `err instanceof SchrodumpError` before wrapping).

- [ ] **Step 3: Type the executor-exit throw.** `restore execution failed (exit code N)` → `new SchrodumpError("restore execution failed (exit code ${exitCode})", { code: "RESTORE_EXECUTOR_FAILED", correlationId: deps.correlationId })`.

- [ ] **Step 4: Verify no unit test broke** and the pieces still typecheck/lint. `pnpm --filter @schrodump/server test && pnpm --filter @schrodump/server typecheck && pnpm --filter @schrodump/server lint`. (restoreOne is not unit-tested — its exercise is the smoke in Task 7. The codes are consumed + tested in Task 5.)

- [ ] **Step 5: Commit.** `refactor(server): type restore-executor failures so verify can classify them`.

---

### Task 4: Domain three-way `VerifyProof`

**Files:**
- Modify: `apps/server/src/jobs/verify.ts`
- Test: `apps/server/src/jobs/verify.test.ts`

**Interfaces:**
- Produces: `export type VerifyProof = "VERIFIED" | "FAILED" | "INCONCLUSIVE";` and `fullRestore(): Promise<VerifyProof>` on `VerifyPorts`. `checksumMatches(): Promise<boolean>` unchanged.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** for the three outcomes + unchanged paths, using the existing verify.test.ts harness (fake ports). Cases:
  - `fullRestore → "VERIFIED"` ⇒ `setArtifactState("VERIFIED")`, job SUCCEEDED, finalState VERIFIED.
  - `fullRestore → "FAILED"` ⇒ `setArtifactState("FAILED")`, job FAILED, finalState FAILED.
  - `fullRestore → "INCONCLUSIVE"` ⇒ `setArtifactState` **NOT called**, job FAILED, finalState `UNOBSERVED`.
  - `CHECKSUM true/false` ⇒ VERIFIED / FAILED (unchanged).
  - sealed FULL_RESTORE still downgrades to CHECKSUM (unchanged).

- [ ] **Step 2: Run — verify they fail** (`fullRestore` still boolean). `pnpm --filter @schrodump/server test verify`.

- [ ] **Step 3: Implement.** Change the `fullRestore` port type to `Promise<VerifyProof>`. In `runVerifyJob`, branch:
  ```ts
  if (level === "FULL_RESTORE") {
    const proof = await ports.fullRestore();
    if (proof === "INCONCLUSIVE") {
      await ports.setJobState("FAILED", "verify inconclusive: the sandbox could not run — artifact unchanged");
      return { finalState: "UNOBSERVED", effectiveLevel: level, degraded: degradedReason !== null };
    }
    const ok = proof === "VERIFIED";
    await ports.setArtifactState(ok ? "VERIFIED" : "FAILED");
    await ports.setJobState(ok ? "SUCCEEDED" : "FAILED", degradedReason ?? undefined);
    return { finalState: ok ? "VERIFIED" : "FAILED", effectiveLevel: level, degraded: degradedReason !== null };
  }
  // CHECKSUM path unchanged (checksumMatches boolean).
  ```
  Keep the outer `try/catch → setArtifactState("FAILED")` (now only reachable via `checksumMatches` throwing).

- [ ] **Step 4: Run tests + typecheck + lint.** Expected: green (verify-wiring.ts will not compile yet — its `fullRestore` returns boolean; that is fixed in Task 5, so run `pnpm --filter @schrodump/server test verify` for this task's tests and expect the typecheck break to be resolved in Task 5. If the reviewer prefers a compiling tree per task, fold Task 5's port-type change into this commit).

- [ ] **Step 5: Commit.** `feat(server): give verify a three-way FULL_RESTORE result (verified/failed/inconclusive)`.

> Note for the implementer: Tasks 4 and 5 together must leave the tree compiling. If executing task-by-task with a green gate, implement Task 5's `verify-wiring.ts` signature change in the same commit as Task 4, or sequence Task 5 immediately after without an intermediate green check on the server package typecheck.

---

### Task 5: `classifyVerifyError` + verify-wiring `VerifyProof`

**Files:**
- Modify: `apps/server/src/jobs/verify-wiring.ts`
- Test: `apps/server/src/jobs/verify-wiring.test.ts` (create)

**Interfaces:**
- Produces: `export function classifyVerifyError(err: unknown): VerifyProof` and the `runFullRestore` dep + `fullRestore` port both typed `Promise<VerifyProof>`.
- Consumes: `VerifyProof` (Task 4), the restore error codes (Task 3).

- [ ] **Step 1: Write the failing tests** for `classifyVerifyError`:
  ```ts
  const err = (code: string) => new SchrodumpError("x", { code, correlationId: "c" });
  expect(classifyVerifyError(err("RESTORE_SOURCE_FAILED"))).toBe("INCONCLUSIVE");
  expect(classifyVerifyError(err("RUNNER_SERVICE_NOT_READY"))).toBe("INCONCLUSIVE");
  expect(classifyVerifyError(err("RUNNER_TIMEOUT"))).toBe("INCONCLUSIVE");
  expect(classifyVerifyError(err("RUNNER_NETWORK_MISSING"))).toBe("INCONCLUSIVE");
  expect(classifyVerifyError(err("RESTORE_DECRYPT_FAILED"))).toBe("FAILED");
  expect(classifyVerifyError(err("RESTORE_EXECUTOR_FAILED"))).toBe("FAILED");
  expect(classifyVerifyError(new Error("surprise"))).toBe("INCONCLUSIVE"); // never FAIL a backup on a surprise
  ```

- [ ] **Step 2: Run — verify it fails.** `pnpm --filter @schrodump/server test verify-wiring`.

- [ ] **Step 3: Implement `classifyVerifyError`.** A `SchrodumpError` whose `code` is one of `RESTORE_DECRYPT_FAILED`, `RESTORE_EXECUTOR_FAILED` → `"FAILED"`; any other `SchrodumpError` code (`RESTORE_SOURCE_FAILED`, `RUNNER_*`) or a non-`SchrodumpError` → `"INCONCLUSIVE"`. Define the FAILED set as an explicit constant with a comment.

- [ ] **Step 4: Change `VerifyWiringDeps.runFullRestore` and the `fullRestore` port to `Promise<VerifyProof>`.** `fullRestore: () => deps.runFullRestore()` stays; only the type changes. Update the `runFullRestore` doc comment (three-way, ephemeral isolated container).

- [ ] **Step 5: Run tests + typecheck + lint** (server package now compiles with Task 4). Expected: green.

- [ ] **Step 6: Commit.** `feat(server): classify verify errors into failed vs inconclusive`.

---

### Task 6: `runFullRestore` composition + `resolveVerifyPlan(engine)`

**Files:**
- Modify: `apps/server/src/jobs/worker-wiring.ts`
- Test: `apps/server/src/jobs/worker-wiring.test.ts`

**Interfaces:**
- Consumes: `withEphemeralService` (T1), `buildVerifySandbox` (T2), `runRestorePipeline` (existing), `classifyVerifyError` (T5), `VerifyProof` (T4).

- [ ] **Step 1: Write failing tests for `resolveVerifyPlan(policyLevel, engine)`:**
  ```ts
  expect(resolveVerifyPlan("FULL_RESTORE", "postgres").effectiveLevel).toBe("FULL_RESTORE");
  expect(resolveVerifyPlan("FULL_RESTORE", "postgres").downgradeReason).toBeNull();
  for (const e of ["mysql","mariadb","mongodb"] as const) {
    expect(resolveVerifyPlan("FULL_RESTORE", e).effectiveLevel).toBe("CHECKSUM");
    expect(resolveVerifyPlan("FULL_RESTORE", e).downgradeReason).toMatch(/PostgreSQL only/i);
  }
  expect(resolveVerifyPlan("CHECKSUM", "mysql").effectiveLevel).toBe("CHECKSUM");
  expect(resolveVerifyPlan(null, "postgres").effectiveLevel).toBe("CHECKSUM");
  ```

- [ ] **Step 2: Run — verify it fails** (signature is `(policyLevel)`).

- [ ] **Step 3: Change `resolveVerifyPlan(policyLevel, engine)`.** Downgrade `FULL_RESTORE → CHECKSUM` only when `engine !== "postgres"`, reason `"FULL_RESTORE runs for PostgreSQL only in v1: downgraded to CHECKSUM"`. Postgres keeps FULL_RESTORE (`downgradeReason: null`). Update the call site (~line 395) to pass the engine, and the stale block comment.

- [ ] **Step 4: Implement `runFullRestore`,** replacing the `Promise.reject(new Error("FULL_RESTORE verify is not wired in v1"))` stub (~line 416). It must, for a postgres artifact:
  ```ts
  runFullRestore: async (): Promise<VerifyProof> => {
    const sandboxPassword = randomUUID();
    const sandbox = adapter.buildVerifySandbox?.(artifact.serverVersionNum, sandboxPassword);
    if (sandbox === undefined) return "INCONCLUSIVE"; // non-postgres never reaches here (plan downgrades), defensive
    // identity + driver materialized exactly as runRestore does (KEK-decrypt EncryptionKey.encryptedIdentity)
    try {
      return await runner.withEphemeralService(
        { image: sandbox.image, env: sandbox.env, network: deps.env.SCHRODUMP_EXECUTOR_NETWORK,
          readinessCommand: sandbox.readinessCommand, port: sandbox.port,
          readinessTimeoutMs: SANDBOX_READY_TIMEOUT_MS, correlationId: job.id },
        async ({ host }) => {
          const conn = { host, port: sandbox.port, username: sandbox.username,
                         password: sandboxPassword, database: sandbox.database, tls: false };
          await runRestorePipeline({
            driver, runner, bucketKey: artifact.bucketKey,
            globalsKey: globalsKeyFor(engine, artifact.serverVersionNum, artifact.bucketKey),
            ageIdentity, network: deps.env.SCHRODUMP_EXECUTOR_NETWORK, timeoutMs: DUMP_TIMEOUT_MS,
            correlationId: job.id,
            buildRestoreDescriptor: (sp) => adapter.buildRestore({ connection: conn, serverVersionNum: artifact.serverVersionNum, target: "FULL_CLUSTER", scope, sourcePath: sp }),
            buildGlobalsRestoreDescriptor: (sp) => adapter.buildGlobalsRestore === undefined ? null : adapter.buildGlobalsRestore({ connection: conn, serverVersionNum: artifact.serverVersionNum, target: "FULL_CLUSTER", scope, sourcePath: sp }),
            reserveStaging: async () => { const r = await scratch.reserve(job.id, DUMP_SCRATCH_BYTES); return { dir: r.path, cleanup: () => r.release() }; },
          });
          const assertRun = await runner.run(
            adapter.buildVerifyAssertions({ connection: conn, serverVersionNum: artifact.serverVersionNum, target: "FULL_CLUSTER", scope }),
            { network: deps.env.SCHRODUMP_EXECUTOR_NETWORK, mounts: [], stdout: <capture>, timeoutMs: DUMP_TIMEOUT_MS, correlationId: job.id });
          const count = Number.parseInt(<captured stdout>.trim(), 10);
          return assertRun.exitCode === 0 && Number.isFinite(count) && count >= 1 ? "VERIFIED" : "FAILED";
        });
    } catch (err) { return classifyVerifyError(err); }
  }
  ```
  Reuse the exact identity-materialization + scratch-mandatory guard already present in `runRestore` (do not duplicate divergently — extract a shared helper if the reviewer flags duplication). Capture the assertion stdout with a `PassThrough` collecting chunks (mirror how backup-wiring collects a stream). `SANDBOX_READY_TIMEOUT_MS` is a new named constant (e.g. 60_000).

- [ ] **Step 4a: Wire the context the verify assembly does not gather today.** The VERIFY dispatch path currently builds `createVerifyPorts` with only `driver`/`bucketKey`/`manifestChecksum`. FULL_RESTORE additionally needs, gathered in the same assembly (mirroring the RESTORE dispatch): the engine `adapter`; the `scope` (`{ databases, schemas, collections }`); `scratch`; and the decryption `ageIdentity` — resolve `resolveDecryptionKeyId(artifact.manifestKeyIds, keys)`, load `EncryptionKey.encryptedIdentity`, and KEK-decrypt it in memory (never on disk). Guard the graceful-degradation cases by returning `"INCONCLUSIVE"` (never `FAILED`): `scratch === null` (cannot stage the cleartext dump), or the identity cannot be resolved/loaded. (Sealed artifacts never reach here — the domain already downgrades them to CHECKSUM via `VerifyContext.sealed` — but the identity guard is the defensive backstop.) The `scope` for verify is the artifact's own scope (or an empty scope — a FULL_CLUSTER restore of the whole dump into the sandbox); do not require an origin target — verify restores into the sandbox, not the origin.

- [ ] **Step 5: Run tests + typecheck + lint.** Full `pnpm --filter @schrodump/server test && pnpm --filter @schrodump/server typecheck && pnpm --filter @schrodump/server lint`. Expected: green (runFullRestore body is exercised by Task 7's smoke).

- [ ] **Step 6: Commit.** `feat(server): run FULL_RESTORE verify in an ephemeral postgres sandbox`.

---

### Task 7: Integration smoke + docs

**Files:**
- Create: `apps/server/src/jobs/full-restore-verify.integration.test.ts` (or extend an existing integration file), `describe.skipIf(!process.env.SCHRODUMP_TEST_INTEGRATION)`.
- Modify: `docs/roadmap.md`, `apps/server/CLAUDE.md`.

- [ ] **Step 1: Write the integration test** (gated), asserting against real Docker + S3/MinIO + a seeded postgres artifact: a FULL_RESTORE verify spins up the sandbox, restores, the assertion passes → `VERIFIED`, and the sandbox container is gone afterward (no leaked container by name/label). Add a case where the sandbox image tag is invalid → `INCONCLUSIVE` and the artifact stays `UNOBSERVED`. Keep credentials out of assertions.

- [ ] **Step 2: Run the unit suite** to confirm the gated test is skipped by default. `pnpm --filter @schrodump/server test`.

- [ ] **Step 3: Update docs.** In `docs/roadmap.md`, remove/adjust the `FULL_RESTORE`-related known-limitation note (verify now runs FULL_RESTORE for postgres; non-postgres downgrades). In `apps/server/CLAUDE.md`, update the verify/roadmap note that says FULL_RESTORE verify is pending.

- [ ] **Step 4: Full workspace verify.** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Expected: all green.

- [ ] **Step 5: Commit.** `test(server): FULL_RESTORE verify integration smoke + docs`.

---

## Manual verification (dev smoke, PostgreSQL)

After Task 6, with the dev worker rebuilt: set a policy's `verifyLevel = FULL_RESTORE`, enqueue a VERIFY of the seeded postgres artifact, and confirm: an ephemeral `postgres:16-alpine` container appears on `schrodump_targets`, the restore runs, the assertion returns ≥1 table, the artifact flips to `VERIFIED`, and the container is force-removed. Then delete a byte of a copy's ciphertext (or point at a corrupt artifact) → `FAILED`. Point at a bad sandbox image → `INCONCLUSIVE`, artifact stays `UNOBSERVED`.
