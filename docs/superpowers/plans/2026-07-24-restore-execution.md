# Restore Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /artifacts/:id/restore` actually restore — enqueue a RESTORE job, dispatch it from the worker, and run a real download → age-decrypt → restore-into-origin-target pipeline, audited.

**Architecture:** The route enqueues a RESTORE `BackupJob` carrying its params in a new `restoreParams` JSON column. The worker's dispatch gains a RESTORE branch that assembles the real `RestorePorts` (the existing `runRestoreJob` orchestration + a `runRestore` executor that is the inverse of the backup pipeline) and runs it. The dialog stops seeing `501`.

**Tech Stack:** Node.js 22 ESM, TypeScript (`nodenext`), Prisma 6 + PostgreSQL, Fastify, Vitest, dockerode (runner), age (decrypt executor), `@schrodump/{core,engines,runner,storage}`.

## Global Constraints

- Every source file (`.ts`) begins with the two-line SPDX header (`// SPDX-License-Identifier: AGPL-3.0-or-later` / `// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA`).
- Dependency graph: `apps/server` composes core/engines/runner/storage; those import only core. `apps/web` imports no workspace package (mirror domain vocab in `src/lib/domain.ts`).
- The worker is the sanctioned system-process exception that uses RAW `prisma` (cross-org), never `scopedPrisma`.
- **No secret ever reaches a log, an HTTP response, or `BackupJob.reason`.** This iteration decrypts the operational **age identity** and the **target credential** — both are used only inside the executor composition, never logged/returned. The identity file is `0600`, mounted read-only, deleted in `finally`.
- An artifact's state is set ONLY by backup (born UNOBSERVED) and verify. **Restore never writes an `Artifact` row** — it reads the artifact and writes the target database.
- Restore is guarded operator+ and is **always audited** (an `AuditLog` row per execution).
- Exit codes: an executor's success is `exitCode === 0`, never inferred from EOF; a non-zero exit fails the restore.
- Conventional Commits, English title, NO Claude/AI/Co-Authored-By attribution.
- Verify: `pnpm typecheck`, `pnpm lint`, `pnpm test` from the repo root. Server unit tests: `cd apps/server && pnpm exec vitest run <file>`.

---

## File Structure

- `apps/server/prisma/schema.prisma` — **modify**: add `restoreParams Json?` to `BackupJob`.
- `apps/server/prisma/migrations/<generated>_restore_params/migration.sql` — **create** via CLI.
- `apps/server/src/routes/jobs.ts` — **modify**: add `enqueueRestore` to `JobsService`.
- `apps/server/src/routes/wiring.ts` — **modify**: implement `enqueueRestore`.
- `apps/server/src/routes/restore.ts` — **modify**: parse the body + enqueue (drop the 501). Takes the `JobsService`.
- `apps/server/src/routes/restore.test.ts` — **modify/create**: enqueue + validation tests.
- `apps/server/src/app.ts` — **modify**: pass the jobs service to `restoreRoutes`.
- `apps/server/src/jobs/worker.ts` — **modify**: add `runRestore` to `JobExecutor` + the RESTORE dispatch branch.
- `apps/server/src/jobs/worker.test.ts` — **modify**: RESTORE dispatch test.
- `apps/server/src/jobs/restore-executor.ts` — **create**: the real `runRestore` pipeline (download → decrypt → restore container) + small pure helpers.
- `apps/server/src/jobs/restore-executor.test.ts` — **create**: unit tests for the pure helpers.
- `apps/server/src/jobs/worker-wiring.ts` — **modify**: add `runRestore` to `createJobExecutor` (assembles `createRestorePorts` + audit/existing-data/restore-executor).
- `apps/web/src/hooks/use-mutations.ts` — **modify**: restore mutation stops treating `501` as expected.
- `apps/web/src/components/restore-dialog.tsx` — **modify**: drop the permanent `serverPending` note; show the enqueued state.

---

## Task 1: Data model + route enqueue (drop the 501)

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (model `BackupJob`), create the migration
- Modify: `apps/server/src/routes/jobs.ts` (`JobsService`), `apps/server/src/routes/wiring.ts` (`createJobsService`), `apps/server/src/routes/restore.ts`, `apps/server/src/app.ts`
- Test: `apps/server/src/routes/restore.test.ts`

**Interfaces:**
- Produces: `BackupJob.restoreParams: Json | null`; `JobsService.enqueueRestore(organizationId, artifactId, params: { target: string; confirmExistingDatabase: boolean; triggeredByUserId: string }): Promise<string>`; `POST /artifacts/:id/restore` → `202 { jobId }`.

- [ ] **Step 1: Add the column**

In `apps/server/prisma/schema.prisma`, inside `model BackupJob`, next to `artifactId`:

```prisma
  // RESTORE-only: { target, confirmExistingDatabase, triggeredByUserId }. Null for BACKUP/VERIFY.
  restoreParams  Json?
```

- [ ] **Step 2: Generate the migration**

```bash
cd apps/server && DATABASE_URL="postgresql://postgres:<pw>@localhost:5433/schrodump?schema=public" \
  pnpm exec prisma migrate dev --name restore_params
```
Expected: one migration adding the nullable column; do NOT accept a reset.

- [ ] **Step 3: Add `enqueueRestore` to the service interface**

In `apps/server/src/routes/jobs.ts`, add to `JobsService`:

```ts
  // Enqueue a RESTORE job for an artifact; params are persisted on the job's restoreParams.
  enqueueRestore(
    organizationId: string,
    artifactId: string,
    params: { target: string; confirmExistingDatabase: boolean; triggeredByUserId: string },
  ): Promise<string>;
```

- [ ] **Step 4: Implement `enqueueRestore`**

In `apps/server/src/routes/wiring.ts` `createJobsService`, add (alongside `enqueueBackup`/`enqueueVerify`):

```ts
    enqueueRestore: async (organizationId, artifactId, params) => {
      const db = scopedPrisma(prisma, organizationId);
      const job = await db.backupJob.create({
        data: {
          organizationId,
          kind: "RESTORE",
          state: "PENDING",
          correlationId: `restore:${artifactId}`,
          artifactId,
          restoreParams: params,
        },
        select: { id: true },
      });
      return job.id;
    },
```

- [ ] **Step 5: Rewrite the route to enqueue**

Replace the body of `apps/server/src/routes/restore.ts` so it parses the request and enqueues. It now takes the jobs service:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";
import type { JobsService } from "./jobs.js";

const ParamsSchema = z.object({ id: z.string().min(1) });
const BodySchema = z.object({
  target: z.enum(["FULL_CLUSTER", "DATABASE", "SCHEMA", "TABLE", "COLLECTION"]),
  confirmExistingDatabase: z.boolean().default(false),
});

// Restore is guarded operator+ (a viewer is refused — audit requirement). It enqueues a RESTORE
// job; the worker runs the real download -> decrypt -> restore pipeline.
export function restoreRoutes(resolver: SessionResolver, service: JobsService) {
  return (app: FastifyInstance): void => {
    app.post(
      "/artifacts/:id/restore",
      { preHandler: [authenticate(resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = ParamsSchema.safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const body = BodySchema.safeParse(request.body ?? {});
        if (!body.success) return reply.status(400).send({ error: "invalid request" });
        const ctx = contextOf(request);
        const jobId = await service.enqueueRestore(ctx.organizationId, params.data.id, {
          target: body.data.target,
          confirmExistingDatabase: body.data.confirmExistingDatabase,
          triggeredByUserId: ctx.userId,
        });
        return reply.status(202).send({ jobId });
      },
    );
  };
}
```

- [ ] **Step 6: Wire the service in `app.ts`**

In `apps/server/src/app.ts`, the `restoreRoutes` registration takes `deps.jobsService`:

```ts
  app.register((instance) => {
    restoreRoutes(deps.resolver, deps.jobsService)(instance);
    return Promise.resolve();
  });
```

- [ ] **Step 7: Write the route tests**

Replace `apps/server/src/routes/restore.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { restoreRoutes } from "./restore.js";
import type { JobsService } from "./jobs.js";

function serviceWith(enqueueRestore = vi.fn(() => Promise.resolve("job-r"))): JobsService {
  return {
    listJobs: () => Promise.resolve([]),
    listArtifacts: () => Promise.resolve([]),
    enqueueBackup: () => Promise.resolve("b"),
    enqueueVerify: () => Promise.resolve("v"),
    enqueueRestore,
    testConnection: () => Promise.resolve({ ok: true, serverVersionNum: 1, failure: null, driverCode: null }),
  };
}

async function appWith(role: Role | null, service: JobsService) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u1", organizationId: "o1", role };
  await app.register((instance) => {
    restoreRoutes(() => Promise.resolve(ctx), service)(instance);
    return Promise.resolve();
  });
  return app;
}

describe("POST /artifacts/:id/restore", () => {
  it("enqueues a RESTORE job with the params and the caller's id (operator)", async () => {
    const enqueue = vi.fn(() => Promise.resolve("job-r"));
    const app = await appWith("operator", serviceWith(enqueue));
    const res = await app.inject({
      method: "POST",
      url: "/artifacts/a1/restore",
      payload: { target: "FULL_CLUSTER", confirmExistingDatabase: true },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ jobId: "job-r" });
    expect(enqueue).toHaveBeenCalledWith("o1", "a1", {
      target: "FULL_CLUSTER",
      confirmExistingDatabase: true,
      triggeredByUserId: "u1",
    });
    await app.close();
  });

  it("refuses a viewer (403)", async () => {
    const app = await appWith("viewer", serviceWith());
    const res = await app.inject({ method: "POST", url: "/artifacts/a1/restore", payload: { target: "FULL_CLUSTER" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("400 on an invalid target", async () => {
    const app = await appWith("operator", serviceWith());
    const res = await app.inject({ method: "POST", url: "/artifacts/a1/restore", payload: { target: "NOPE" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 8: Run tests + typecheck**

Run: `cd apps/server && pnpm exec vitest run src/routes/restore.test.ts` (3 pass), then `pnpm typecheck` (updates any other `JobsService` mock — e.g. `jobs.test.ts`'s fake service — to include `enqueueRestore`).
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/prisma apps/server/src/routes apps/server/src/app.ts
git commit -m "feat(server): enqueue a RESTORE job instead of returning 501"
```

---

## Task 2: Worker RESTORE dispatch

**Files:**
- Modify: `apps/server/src/jobs/worker.ts` (`JobExecutor` + dispatch)
- Test: `apps/server/src/jobs/worker.test.ts`

**Interfaces:**
- Consumes: `ClaimedJob`, `WorkerDeps` (unchanged).
- Produces: `JobExecutor.runRestore(job: ClaimedJob): Promise<void>`.

- [ ] **Step 1: Add the failing test**

In `apps/server/src/jobs/worker.test.ts`, extend the fake executor with `runRestore` and add a case. Add to the `makeDeps` executor:

```ts
    runRestore: over.restore ?? (() => Promise.resolve()),
```
and to the `over` type: `restore?: JobExecutor["runRestore"];`. Then add:

```ts
  it("dispatches a RESTORE job to runRestore and chains nothing", async () => {
    const runRestore = vi.fn(() => Promise.resolve());
    const restoreJob: ClaimedJob = {
      id: "j4", organizationId: "o1", kind: "RESTORE", policyId: null, artifactId: "a1", correlationId: "restore:a1",
    };
    const { deps, store } = makeDeps({ jobs: [restoreJob], restore: runRestore });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(runRestore).toHaveBeenCalledOnce();
    expect(store.enqueueVerify).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server && pnpm exec vitest run src/jobs/worker.test.ts`
Expected: FAIL — `runRestore` is not on `JobExecutor` / `RESTORE` hits the unsupported-kind branch.

- [ ] **Step 3: Add `runRestore` to the interface and dispatch**

In `apps/server/src/jobs/worker.ts`, add to `JobExecutor`:

```ts
  // Runs restore (which sets the RESTORE job's terminal state via its own ports).
  runRestore(job: ClaimedJob): Promise<void>;
```

In `runWorkerOnce`, add the branch before the `else`:

```ts
    } else if (job.kind === "VERIFY") {
      await deps.executor.runVerify(job);
    } else if (job.kind === "RESTORE") {
      await deps.executor.runRestore(job);
    } else {
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && pnpm exec vitest run src/jobs/worker.test.ts`
Expected: PASS (all cases, including the new RESTORE one).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/jobs/worker.ts apps/server/src/jobs/worker.test.ts
git commit -m "feat(server): dispatch RESTORE jobs in the worker"
```

---

## Task 3: The real restore executor (`runRestore`) + audit + existing-data assembly

This is the runtime "ligação" and the security-critical piece. It needs Docker + S3 + a target DB, so it is verified by typecheck/lint + the dev smoke (Task 5), not a unit test — EXCEPT the small pure helpers, which are unit-tested. Read `jobs/backup-wiring.ts` (the pipeline to invert), `jobs/restore.ts` / `restore-wiring.ts` (the ports), `crypto/artifact.ts` (`buildAgeDecryptDescriptor`, `resolveDecryptionKeyId`), `crypto/envelope.ts` (`decryptCredential`), `packages/engines/src/descriptor.ts` (`buildRestore`, `RestoreInput`), and `jobs/worker-wiring.ts`'s `runVerify` (the template to mirror) before writing.

**Files:**
- Create: `apps/server/src/jobs/restore-executor.ts`, `apps/server/src/jobs/restore-executor.test.ts`
- Modify: `apps/server/src/jobs/worker-wiring.ts` (add `runRestore` to `createJobExecutor`)

**Interfaces:**
- Consumes: `runRestoreJob`/`RestoreRequest`/`RestorePorts` (`jobs/restore.ts`), `createRestorePorts`/`RestoreWiringDeps` (`jobs/restore-wiring.ts`), `resolveDecryptionKeyId`/`buildAgeDecryptDescriptor`/`EncryptionKeyRecord` (`crypto/artifact.ts`), `decryptCredential`/`parseEncryptedCredential` (`crypto/envelope.ts`), `resolveAdapter` (`@schrodump/engines/registry`), the `Runner` + `ScratchManager`, `driverForDestination` (`jobs/destination-driver.ts`).
- Produces: `runRestorePipeline(deps): Promise<boolean>` and pure helpers (`restoreParamsOf`, the identity-file lifecycle); `createJobExecutor(...).runRestore`.

- [ ] **Step 1: Pure helper — parse and validate `restoreParams` (TDD)**

Write `apps/server/src/jobs/restore-executor.test.ts` first:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { restoreParamsOf } from "./restore-executor.js";

describe("restoreParamsOf", () => {
  it("reads a valid RESTORE job's params", () => {
    const p = restoreParamsOf({ target: "DATABASE", confirmExistingDatabase: true, triggeredByUserId: "u1" });
    expect(p).toEqual({ target: "DATABASE", confirmExistingDatabase: true, triggeredByUserId: "u1" });
  });

  it("throws on missing/garbage params (a RESTORE job must carry them)", () => {
    expect(() => restoreParamsOf(null)).toThrow();
    expect(() => restoreParamsOf({ target: "NOPE" })).toThrow();
  });
});
```

Run it (RED), then implement in `apps/server/src/jobs/restore-executor.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { z } from "zod";
import type { RestoreTarget } from "./restore.js";

const RestoreParamsSchema = z.object({
  target: z.enum(["FULL_CLUSTER", "DATABASE", "SCHEMA", "TABLE", "COLLECTION"]),
  confirmExistingDatabase: z.boolean(),
  triggeredByUserId: z.string().min(1),
});

export interface RestoreParams {
  target: RestoreTarget;
  confirmExistingDatabase: boolean;
  triggeredByUserId: string;
}

// A RESTORE job MUST carry its params (the route persisted them); a null/garbage value is a hard
// error, never a silent default that would restore with the wrong scope.
export function restoreParamsOf(raw: unknown): RestoreParams {
  return RestoreParamsSchema.parse(raw);
}
```

Run it (GREEN).

- [ ] **Step 2: Implement `runRestorePipeline` (the inverse-of-backup executor)**

Append to `restore-executor.ts`. This composes the real download → decrypt → restore. It is not unit-tested (Docker/S3/target); its correctness is the Task 5 smoke. Mirror `backup-wiring.ts`'s `uploadEncrypted` inverted: capture each `RunResult` and throw on `exitCode !== 0`. The identity is written to a `0600` scratch file, mounted read-only into the age executor, and deleted in `finally`. Signature:

```ts
export interface RestorePipelineDeps {
  driver: import("@schrodump/storage/driver").StorageDriver;
  runner: import("@schrodump/runner/runner").Runner;
  bucketKey: string;          // the artifact.bin key
  globalsKey: string | null;  // the globals.bin key for postgres, else null
  ageIdentity: string;        // AGE-SECRET-KEY-1... (KEK-decrypted operational identity)
  network: string;            // executor network
  timeoutMs: number;
  buildRestoreDescriptor: () => import("@schrodump/core/execution").ExecutionDescriptor; // engine restore
  buildGlobalsRestoreDescriptor: () => import("@schrodump/core/execution").ExecutionDescriptor | null;
  writeIdentityFile: (identity: string) => Promise<{ path: string; cleanup: () => Promise<void> }>; // 0600
}

// Downloads the encrypted object, pipes it through the age-decrypt executor (identity mounted, never
// on argv) then gunzip, into the engine restore executor connected to the origin target. Returns
// true iff every executor exits 0. The identity file is always removed in finally.
export async function runRestorePipeline(deps: RestorePipelineDeps): Promise<boolean>;
```

The step's deliverable is the body: `writeIdentityFile` → for globals then the main artifact, `driver.get(key)` → `runner.run(buildAgeDecryptDescriptor(), { mounts: [identity ro at /etc/schrodump/age-identity], stdin: <s3 stream>, stdout: <pipe> })` → gunzip → `runner.run(buildRestoreDescriptor(), { network, stdin: <decrypted+gunzipped>, ... })`; check every `RunResult.exitCode === 0`; `finally { await cleanup(); }`. Match the `RunOptions`/`Runner` contract in `packages/runner/src/runner.ts` (note: if it has no `stdin`, the descriptor consumes the mounted/staged input — read the runner contract and use the same input mechanism the backup path uses in reverse).

> If the runner's `RunOptions` does not support the stdin/stream shape restore needs, STOP and report NEEDS_CONTEXT — do not invent a runner API. The backup path streams executor stdout OUT; restore needs to stream IN, which may require a runner capability check.

- [ ] **Step 3: Add `runRestore` to `createJobExecutor`**

In `apps/server/src/jobs/worker-wiring.ts`, add `runRestore` mirroring `runVerify`:

```ts
  const runRestore = async (job: ClaimedJob): Promise<void> => {
    // 1. restoreParamsOf(job.restoreParams) -> { target, confirmExistingDatabase, triggeredByUserId }.
    //    (ClaimedJob must now carry restoreParams — see Step 4.)
    // 2. Load artifact + its origin target (artifact.job.policy.targetId) + destination + manifest keyIds.
    // 3. Build RestoreWiringDeps:
    //    - loadArtifactRow: { manifestKeyIds, engine, serverVersionNum, destinationName }.
    //    - availableKeys: EncryptionKey rows (active + retired) -> EncryptionKeyRecord[].
    //    - targetHasExistingData: probe the origin target (does it hold data?).
    //    - audit: write an AuditLog row (action "restore.execute", targetType "artifact",
    //      targetId artifactId, userId triggeredByUserId, correlationId job.correlationId,
    //      metadata { destinationName, keyId }).
    //    - setJobState: update the BackupJob.
    //    - runRestore: (keyId) => { decrypt the target credential (KEK); load the operational
    //      EncryptionKey.encryptedIdentity for keyId and KEK-decrypt it -> ageIdentity; build the
    //      driver (driverForDestination); resolveAdapter(engine).buildRestore(...); call
    //      runRestorePipeline(...). }.
    // 4. runRestoreJob({ jobId: job.id, artifactId, organizationId: job.organizationId,
    //      userId: params.triggeredByUserId, target: params.target,
    //      confirmExistingDatabase: params.confirmExistingDatabase }, createRestorePorts(deps)).
    throw new Error("implement per the composition above");
  };
```

Add `runRestore` to the returned object: `return { runBackup, runVerify, runRestore };`.

- [ ] **Step 4: Carry `restoreParams` on `ClaimedJob`**

`claimNextJob` (`jobs/claim.ts`) currently `RETURNING` selects the columns of `ClaimedJob`. Add `restoreParams` to both the `ClaimedJob` type (`worker.ts`: `restoreParams: unknown`) and the claim's `RETURNING ... "restoreParams"`. Update the `claim.test.ts` assertions only if they check the row shape.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Resolve every signature mismatch against the source files.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/jobs/restore-executor.ts apps/server/src/jobs/restore-executor.test.ts \
        apps/server/src/jobs/worker-wiring.ts apps/server/src/jobs/worker.ts apps/server/src/jobs/claim.ts
git commit -m "feat(server): assemble the real restore executor (download, decrypt, restore)"
```

---

## Task 4: Web — wire the restore dialog

**Files:**
- Modify: `apps/web/src/hooks/use-mutations.ts` (restore mutation), `apps/web/src/components/restore-dialog.tsx`
- Test: `apps/web/src/components/restore-dialog.test.tsx` (existing — update if it asserts the 501/pending copy)

**Interfaces:**
- Consumes: `POST /backend/artifacts/:id/restore` now returns `202 { jobId }`.

- [ ] **Step 1: Stop treating 501 as expected**

In `apps/server`'s web client (`apps/web/src/hooks/use-mutations.ts`), the restore mutation currently anticipates `501`. Make it a normal `api.post` that resolves on `202` and surfaces the enqueued state (`{ jobId }`). Read the current mutation and remove the 501-specific handling.

- [ ] **Step 2: Update the dialog copy/state**

In `apps/web/src/components/restore-dialog.tsx`, remove the permanent `t("restore.serverPending")` note (line ~150). On a successful enqueue (`restore.isSuccess`), show a brief "restore enqueued" confirmation (add an i18n key `restore.enqueued` to `en.ts` + `pt-BR.ts` + `es.ts` — a content change touches all three dictionaries) and/or close the dialog. Keep the friction (scope, retype-to-confirm) unchanged.

- [ ] **Step 3: Update/verify the component test**

Run: `cd apps/web && pnpm exec vitest run src/components/restore-dialog.test.tsx`. Update any assertion that checked the `serverPending` copy; assert the submit calls the mutation with `{ artifactId, target, confirmExistingDatabase }` and that a successful enqueue shows the confirmation.
Expected: PASS.

- [ ] **Step 4: Typecheck (web) + i18n completeness**

Run: `pnpm typecheck` (the `Record<MessageKey, string>` types force `restore.enqueued` into `pt-BR.ts` and `es.ts` or the build fails).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): trigger restore and show the enqueued state (no more 501)"
```

---

## Task 5: Dev end-to-end smoke

Not a code task — the proof that restore restores. Uses the dev stack (a rebuilt server with the worker; MinIO; the seed target).

- [ ] **Step 1: Ensure the prerequisites**

- The dev stack from the worker smoke (server + MinIO + seed target + `EncryptionKey` operational/escrow rows + a VERIFIED artifact) is up, or stood up again.
- The `age` restore executor image and the engine restore image are present (build from `docker/executors/` if needed).

- [ ] **Step 2: Restore into a fresh database**

- Create an empty database on the seed target (e.g. `appdb_restored`), or restore FULL_CLUSTER and observe.
- Trigger a restore of the VERIFIED artifact via the UI (operator+) — pick a supported scope, confirm if over existing.
- Observe: the RESTORE job goes `PENDING → RUNNING → SUCCEEDED`; an `AuditLog` row is written (`action = restore.execute`).
- Assert the restored data is present (row counts match the source `customers` table).

- [ ] **Step 3: Verify the friction**

- Trigger a restore-over-existing WITHOUT the confirmation → the job FAILS with the confirmation reason.
- Retry WITH `confirmExistingDatabase` → SUCCEEDED.

> If a dev dependency (age/engine restore image) proves impractical, record exactly which step blocked and rely on unit + gated integration coverage; do not claim the smoke passed if it did not.

---

## Follow-ups (out of scope, tracked)

1. Sub-scope restore (a named database/schema/table) — the web must send the name.
2. In-memory identity supply for sealed artifacts.
3. FULL_RESTORE verify (restore into an ephemeral container), removing the CHECKSUM downgrade.
4. Restore into a different target than the origin.
5. Update `apps/server/CLAUDE.md` / `docs/roadmap.md` (restore no longer 501) once this lands.
