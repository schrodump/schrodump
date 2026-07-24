# Job Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the consumer that claims `PENDING` `BackupJob`s and runs them end-to-end — a backup produces an `UNOBSERVED` artifact, then a chained verify promotes it to `VERIFIED`/`FAILED`.

**Architecture:** A single-flight poll loop in the API process claims one job at a time with `FOR UPDATE SKIP LOCKED`, dispatches by kind to a real `JobExecutor` that composes the existing pure job functions (`runBackupJob`, `runVerifyJob`) with the runner + storage + engines, and enqueues a follow-up `VERIFY` job after a successful backup. The pure "brain" (`runWorkerOnce`) is unit-tested with fakes; the runtime assembly follows the existing `*-wiring.ts` template and is verified by typecheck + gated integration + a dev smoke.

**Tech Stack:** Node.js 22 ESM, TypeScript (`nodenext`), Prisma 6 + PostgreSQL, Fastify, Vitest, dockerode (runner), age-encryption, `@schrodump/{core,engines,runner,storage}`.

## Global Constraints

- Every source file (`.ts`) begins with the two-line SPDX header:
  `// SPDX-License-Identifier: AGPL-3.0-or-later` and
  `// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA`.
- Dependency graph: `apps/server` may import `core`/`engines`/`runner`/`storage`; those packages import only `core`, never each other.
- Every domain model carries `organizationId`; all tenant queries go through `scopedPrisma(prisma, organizationId)`. The **worker/scheduler is the one system-process exception** — it queries across organizations, so it uses the raw `prisma` client, not `scopedPrisma`.
- No secret in any log level. Reasons written to `BackupJob.reason` must be sanitized — never a raw driver/error message (they embed credentials).
- BigInt never reaches a Fastify response (already handled for artifacts; keep it true).
- An artifact is born `UNOBSERVED`; **only `runVerifyJob` may set `VERIFIED`/`FAILED`**. Never create or promote an artifact anywhere else.
- Verify commands: `pnpm typecheck`, `pnpm lint`, `pnpm test` from the repo root. Server unit tests: `cd apps/server && pnpm exec vitest run <file>`. Integration tests are gated by `SCHRODUMP_TEST_INTEGRATION=1`.
- Conventional Commits, English title, no attribution/co-author lines.

---

## File Structure

- `apps/server/prisma/schema.prisma` — **modify**: add `artifactId` + `verifyArtifact` relation to `BackupJob`.
- `apps/server/prisma/migrations/<generated>_job_worker/migration.sql` — **create** via `prisma migrate dev`.
- `apps/server/src/routes/wiring.ts` — **modify**: `enqueueBackup` sets `policyId`; `enqueueVerify` sets `artifactId`.
- `apps/server/src/jobs/worker.ts` — **create**: `ClaimedJob`, `JobExecutor`, `WorkerStore`, `WorkerDeps`, `runWorkerOnce`, `drainQueue`.
- `apps/server/src/jobs/worker.test.ts` — **create**: unit tests for the brain (fakes).
- `apps/server/src/jobs/claim.ts` — **create**: `claimNextJob(prisma)` (SKIP LOCKED).
- `apps/server/src/jobs/claim.test.ts` — **create**: gated integration test.
- `apps/server/src/env.ts` — **modify**: scratch/executor/DOCKER vars with defaults.
- `apps/server/src/env.test.ts` — **create**: defaults + parsing.
- `apps/server/src/jobs/worker-wiring.ts` — **create**: real `WorkerStore` + `JobExecutor` (runtime assembly).
- `apps/server/src/server.ts` — **modify**: boot orphan recovery + `startWorker` under advisory lock + `SIGTERM` handler.
- `apps/server/src/jobs/worker-loop.ts` — **create**: `startWorker` timer wrapper + `installShutdown`.

---

## Task 1: Data model — `artifactId` on `BackupJob` and enqueue fixes

**Files:**
- Modify: `apps/server/prisma/schema.prisma` (model `BackupJob`)
- Create: `apps/server/prisma/migrations/<generated>_job_worker/migration.sql` (via CLI)
- Modify: `apps/server/src/routes/wiring.ts` (`createJobsService`)

**Interfaces:**
- Produces: `BackupJob.artifactId: string | null` column; `enqueueBackup` now persists `policyId`; `enqueueVerify` now persists `artifactId`.

- [ ] **Step 1: Add the column + relation to the schema**

In `apps/server/prisma/schema.prisma`, inside `model BackupJob`, add the field next to the other optional columns and a named relation to `Artifact` (the existing `artifact Artifact?` back-relation stays — this new one is the "artifact this VERIFY job targets"):

```prisma
  // The artifact a VERIFY job targets. Null for BACKUP/RESTORE jobs. Structural link so the
  // worker never parses correlationId.
  artifactId     String?
```

Add the relation line among the relations block of `BackupJob`:

```prisma
  verifyArtifact Artifact? @relation("VerifyTarget", fields: [artifactId], references: [id])
```

In `model Artifact`, add the back-relation (a name is required because `Artifact` now has two relations to `BackupJob`):

```prisma
  verifyJobs   BackupJob[]        @relation("VerifyTarget")
```

The existing `job BackupJob @relation(fields: [jobId], ...)` relation on `Artifact` and `artifact Artifact?` on `BackupJob` are the producing-backup link; give that existing pair a name too so Prisma can tell them apart. On `BackupJob`: `artifact Artifact? @relation("ProducedBy")`. On `Artifact`: `job BackupJob @relation("ProducedBy", fields: [jobId], references: [id], onDelete: Cascade)`.

- [ ] **Step 2: Generate the migration**

Run (dev Postgres must be up on `localhost:5433`; `DATABASE_URL` set):

```bash
cd apps/server && DATABASE_URL="postgresql://postgres:<pw>@localhost:5433/schrodump?schema=public" \
  pnpm exec prisma migrate dev --name job_worker
```

Expected: a new migration folder is created and applied; `prisma generate` runs.

- [ ] **Step 3: Set `policyId` and `artifactId` on enqueue**

In `apps/server/src/routes/wiring.ts`, change the `enqueue` closure in `createJobsService` so BACKUP carries its policy and VERIFY carries its artifact:

```ts
const enqueue = async (
  organizationId: string,
  kind: "BACKUP" | "VERIFY",
  ref: { policyId: string } | { artifactId: string },
): Promise<string> => {
  const db = scopedPrisma(prisma, organizationId);
  const correlationId = "policyId" in ref ? `backup:${ref.policyId}` : `verify:${ref.artifactId}`;
  const job = await db.backupJob.create({
    data: {
      organizationId,
      kind,
      state: "PENDING",
      correlationId,
      ...("policyId" in ref ? { policyId: ref.policyId } : { artifactId: ref.artifactId }),
    },
    select: { id: true },
  });
  return job.id;
};
return {
  // ...unchanged listJobs / listArtifacts / testConnection...
  enqueueBackup: (organizationId, policyId) => enqueue(organizationId, "BACKUP", { policyId }),
  enqueueVerify: (organizationId, artifactId) => enqueue(organizationId, "VERIFY", { artifactId }),
};
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (Prisma client regenerated with `artifactId`).

- [ ] **Step 5: Verify the column exists in the dev DB**

Run: `docker exec schrodump-pg psql -U postgres -d schrodump -c '\d "BackupJob"' | grep artifactId`
Expected: a row showing `artifactId | text |` (nullable).

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations apps/server/src/routes/wiring.ts
git commit -m "feat(server): link VERIFY jobs to their artifact and backups to their policy"
```

---

## Task 2: Worker brain — `runWorkerOnce` and `drainQueue`

**Files:**
- Create: `apps/server/src/jobs/worker.ts`
- Test: `apps/server/src/jobs/worker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ClaimedJob {
    id: string;
    organizationId: string;
    kind: "BACKUP" | "VERIFY" | "RESTORE";
    policyId: string | null;
    artifactId: string | null;
    correlationId: string;
  }
  export type VerifyLevel = "NONE" | "CHECKSUM" | "FULL_RESTORE";
  export interface BackupResult { ok: boolean; artifactId: string | null; verifyLevel: VerifyLevel; }
  export interface JobExecutor {
    runBackup(job: ClaimedJob): Promise<BackupResult>;
    runVerify(job: ClaimedJob): Promise<void>;
  }
  export interface WorkerStore {
    claimNextJob(): Promise<ClaimedJob | null>;
    failJob(jobId: string, reason: string): Promise<void>;
    enqueueVerify(organizationId: string, artifactId: string): Promise<string>;
  }
  export interface WorkerLogger { info(o: Record<string, unknown>, m: string): void; error(o: Record<string, unknown>, m: string): void; }
  export interface WorkerDeps { store: WorkerStore; executor: JobExecutor; log: WorkerLogger; sanitizeReason(err: unknown): string; }
  export function runWorkerOnce(deps: WorkerDeps): Promise<"ran" | "idle">;
  export function drainQueue(deps: WorkerDeps): Promise<number>;
  ```
- Consumes: nothing (fakes in the test).

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/jobs/worker.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import {
  drainQueue,
  runWorkerOnce,
  type ClaimedJob,
  type JobExecutor,
  type WorkerDeps,
  type WorkerStore,
} from "./worker.js";

const backupJob: ClaimedJob = {
  id: "j1", organizationId: "o1", kind: "BACKUP", policyId: "p1", artifactId: null, correlationId: "backup:p1",
};
const verifyJob: ClaimedJob = {
  id: "j2", organizationId: "o1", kind: "VERIFY", policyId: null, artifactId: "a1", correlationId: "verify:a1",
};

function makeDeps(over: {
  jobs?: (ClaimedJob | null)[];
  backup?: JobExecutor["runBackup"];
  verify?: JobExecutor["runVerify"];
}): { deps: WorkerDeps; store: { enqueueVerify: ReturnType<typeof vi.fn>; failJob: ReturnType<typeof vi.fn> } } {
  const queue = [...(over.jobs ?? [])];
  const enqueueVerify = vi.fn(() => Promise.resolve("v1"));
  const failJob = vi.fn(() => Promise.resolve());
  const store: WorkerStore = {
    claimNextJob: () => Promise.resolve(queue.length > 0 ? (queue.shift() as ClaimedJob | null) : null),
    failJob,
    enqueueVerify,
  };
  const executor: JobExecutor = {
    runBackup: over.backup ?? (() => Promise.resolve({ ok: true, artifactId: "a1", verifyLevel: "CHECKSUM" })),
    runVerify: over.verify ?? (() => Promise.resolve()),
  };
  const log = { info: () => {}, error: () => {} };
  return { deps: { store, executor, log, sanitizeReason: () => "sanitized" }, store: { enqueueVerify, failJob } };
}

describe("runWorkerOnce", () => {
  it("returns idle and does nothing when the queue is empty", async () => {
    const { deps, store } = makeDeps({ jobs: [] });
    expect(await runWorkerOnce(deps)).toBe("idle");
    expect(store.failJob).not.toHaveBeenCalled();
  });

  it("chains a VERIFY after a successful backup whose policy verifies", async () => {
    const { deps, store } = makeDeps({ jobs: [backupJob] });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.enqueueVerify).toHaveBeenCalledWith("o1", "a1");
  });

  it("does not chain a VERIFY when the policy's verify level is NONE", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () => Promise.resolve({ ok: true, artifactId: "a1", verifyLevel: "NONE" }),
    });
    await runWorkerOnce(deps);
    expect(store.enqueueVerify).not.toHaveBeenCalled();
  });

  it("does not chain when the backup failed", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () => Promise.resolve({ ok: false, artifactId: null, verifyLevel: "CHECKSUM" }),
    });
    await runWorkerOnce(deps);
    expect(store.enqueueVerify).not.toHaveBeenCalled();
    expect(store.failJob).not.toHaveBeenCalled(); // the pure job already set FAILED via its ports
  });

  it("runs a VERIFY job and chains nothing", async () => {
    const runVerify = vi.fn(() => Promise.resolve());
    const { deps, store } = makeDeps({ jobs: [verifyJob], verify: runVerify });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(runVerify).toHaveBeenCalledOnce();
    expect(store.enqueueVerify).not.toHaveBeenCalled();
  });

  it("fails an unsupported kind", async () => {
    const restore: ClaimedJob = { ...verifyJob, id: "j3", kind: "RESTORE", artifactId: null };
    const { deps, store } = makeDeps({ jobs: [restore] });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.failJob).toHaveBeenCalledWith("j3", expect.stringContaining("RESTORE"));
  });

  it("catches a thrown executor and fails the job with a sanitized reason", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () => Promise.reject(new Error("password=hunter2 leaked")),
    });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.failJob).toHaveBeenCalledWith("j1", "sanitized");
  });
});

describe("drainQueue", () => {
  it("drains every ready job then stops, returning the count", async () => {
    const { deps } = makeDeps({ jobs: [backupJob, verifyJob, backupJob] });
    expect(await drainQueue(deps)).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server && pnpm exec vitest run src/jobs/worker.test.ts`
Expected: FAIL — cannot resolve `./worker.js`.

- [ ] **Step 3: Implement `worker.ts`**

Create `apps/server/src/jobs/worker.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The worker brain: claim one job, dispatch by kind, chain backup -> verify. Deliberately free of
// I/O so it is unit-tested with fakes; the real store/executor are assembled in worker-wiring.ts.

export interface ClaimedJob {
  id: string;
  organizationId: string;
  kind: "BACKUP" | "VERIFY" | "RESTORE";
  policyId: string | null;
  artifactId: string | null;
  correlationId: string;
}

export type VerifyLevel = "NONE" | "CHECKSUM" | "FULL_RESTORE";

export interface BackupResult {
  ok: boolean;
  artifactId: string | null;
  verifyLevel: VerifyLevel;
}

export interface JobExecutor {
  // Runs the backup pipeline (which sets the job's terminal state via its own ports) and reports
  // the outcome the worker needs to decide chaining.
  runBackup(job: ClaimedJob): Promise<BackupResult>;
  // Runs verify (which sets the job AND artifact terminal state via its own ports).
  runVerify(job: ClaimedJob): Promise<void>;
}

export interface WorkerStore {
  claimNextJob(): Promise<ClaimedJob | null>;
  failJob(jobId: string, reason: string): Promise<void>;
  enqueueVerify(organizationId: string, artifactId: string): Promise<string>;
}

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface WorkerDeps {
  store: WorkerStore;
  executor: JobExecutor;
  log: WorkerLogger;
  // Turns an arbitrary thrown value into a log/DB-safe reason (never a raw driver message).
  sanitizeReason(err: unknown): string;
}

export async function runWorkerOnce(deps: WorkerDeps): Promise<"ran" | "idle"> {
  const job = await deps.store.claimNextJob();
  if (job === null) return "idle";

  try {
    if (job.kind === "BACKUP") {
      const result = await deps.executor.runBackup(job);
      if (result.ok && result.artifactId !== null && result.verifyLevel !== "NONE") {
        await deps.store.enqueueVerify(job.organizationId, result.artifactId);
        deps.log.info({ jobId: job.id, artifactId: result.artifactId }, "backup ok — verify enqueued");
      }
    } else if (job.kind === "VERIFY") {
      await deps.executor.runVerify(job);
    } else {
      await deps.store.failJob(job.id, `unsupported job kind: ${job.kind}`);
    }
  } catch (err) {
    const reason = deps.sanitizeReason(err);
    deps.log.error({ jobId: job.id, reason }, "job crashed — marking FAILED");
    await deps.store.failJob(job.id, reason);
  }
  return "ran";
}

export async function drainQueue(deps: WorkerDeps): Promise<number> {
  let count = 0;
  while ((await runWorkerOnce(deps)) === "ran") count += 1;
  return count;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/server && pnpm exec vitest run src/jobs/worker.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/jobs/worker.ts apps/server/src/jobs/worker.test.ts
git commit -m "feat(server): add the worker brain (claim, dispatch, backup->verify chaining)"
```

---

## Task 3: `claimNextJob` — atomic claim with `FOR UPDATE SKIP LOCKED`

**Files:**
- Create: `apps/server/src/jobs/claim.ts`
- Test: `apps/server/src/jobs/claim.test.ts` (gated integration)

**Interfaces:**
- Consumes: `ClaimedJob` from `worker.ts`.
- Produces: `claimNextJob(prisma: PrismaClient): Promise<ClaimedJob | null>`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/server/src/jobs/claim.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { claimNextJob } from "./claim.js";

const RUN = process.env.SCHRODUMP_TEST_INTEGRATION === "1";

describe.skipIf(!RUN)("claimNextJob (integration)", () => {
  const prisma = new PrismaClient();
  let orgId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: "claim-test" } });
    orgId = org.id;
  });
  afterAll(async () => {
    await prisma.backupJob.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.backupJob.deleteMany({ where: { organizationId: orgId } });
  });

  it("returns null when there is no pending job", async () => {
    expect(await claimNextJob(prisma)).toBeNull();
  });

  it("claims a pending job, flips it to RUNNING, and never hands the same row twice", async () => {
    await prisma.backupJob.create({ data: { organizationId: orgId, kind: "BACKUP", state: "PENDING", correlationId: "c1" } });
    await prisma.backupJob.create({ data: { organizationId: orgId, kind: "BACKUP", state: "PENDING", correlationId: "c2" } });

    const [a, b, c] = await Promise.all([claimNextJob(prisma), claimNextJob(prisma), claimNextJob(prisma)]);
    const claimed = [a, b, c].filter((j): j is NonNullable<typeof j> => j !== null);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((j) => j.id)).size).toBe(2); // no double-claim
    for (const j of claimed) {
      const row = await prisma.backupJob.findUnique({ where: { id: j.id } });
      expect(row?.state).toBe("RUNNING");
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server && SCHRODUMP_TEST_INTEGRATION=1 DATABASE_URL="postgresql://postgres:<pw>@localhost:5433/schrodump?schema=public" pnpm exec vitest run src/jobs/claim.test.ts`
Expected: FAIL — cannot resolve `./claim.js`.

- [ ] **Step 3: Implement `claim.ts`**

Create `apps/server/src/jobs/claim.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import type { ClaimedJob } from "./worker.js";

// Atomic claim: pick the oldest PENDING job, skip rows another worker already locked, flip it to
// RUNNING, and return it. FOR UPDATE SKIP LOCKED makes concurrent claims (and future replicas)
// safe without a double-run. System-process query — intentionally cross-organization, raw prisma.
export async function claimNextJob(prisma: PrismaClient): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "BackupJob"
       SET state = 'RUNNING', "startedAt" = now()
     WHERE id = (
       SELECT id FROM "BackupJob"
        WHERE state = 'PENDING'
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, "organizationId", kind, "policyId", "artifactId", "correlationId";
  `;
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/server && SCHRODUMP_TEST_INTEGRATION=1 DATABASE_URL="postgresql://postgres:<pw>@localhost:5433/schrodump?schema=public" pnpm exec vitest run src/jobs/claim.test.ts`
Expected: PASS (2 tests). Without the env var the suite is skipped (still green).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/jobs/claim.ts apps/server/src/jobs/claim.test.ts
git commit -m "feat(server): claim PENDING jobs atomically with FOR UPDATE SKIP LOCKED"
```

---

## Task 4: `env.ts` — scratch / executor / Docker configuration

**Files:**
- Modify: `apps/server/src/env.ts`
- Test: `apps/server/src/env.test.ts` (create)

**Interfaces:**
- Produces on `Env`: `SCHRODUMP_SCRATCH_PATH: string | undefined`, `SCHRODUMP_SCRATCH_MAX_BYTES: number`, `SCHRODUMP_MAX_CONCURRENT_STAGED: number`, `SCHRODUMP_EXECUTOR_NETWORK: string`, `WORKER_POLL_MS: number`. (`DOCKER_HOST` stays read by the runner's `dockerFromEnv`, not by `env.ts`.)

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/env.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = { DATABASE_URL: "postgres://x", SCHRODUMP_KEK: "k" };

describe("loadEnv worker config", () => {
  it("applies defaults when the worker vars are absent", () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.SCHRODUMP_SCRATCH_PATH).toBeUndefined();
    expect(env.SCHRODUMP_MAX_CONCURRENT_STAGED).toBe(2);
    expect(env.SCHRODUMP_EXECUTOR_NETWORK).toBe("schrodump_targets");
    expect(env.WORKER_POLL_MS).toBe(2000);
  });

  it("coerces the numeric vars", () => {
    const env = loadEnv({
      ...base,
      SCHRODUMP_SCRATCH_PATH: "/scratch",
      SCHRODUMP_SCRATCH_MAX_BYTES: "1024",
      SCHRODUMP_MAX_CONCURRENT_STAGED: "4",
      WORKER_POLL_MS: "500",
    } as NodeJS.ProcessEnv);
    expect(env.SCHRODUMP_SCRATCH_PATH).toBe("/scratch");
    expect(env.SCHRODUMP_SCRATCH_MAX_BYTES).toBe(1024);
    expect(env.SCHRODUMP_MAX_CONCURRENT_STAGED).toBe(4);
    expect(env.WORKER_POLL_MS).toBe(500);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server && pnpm exec vitest run src/env.test.ts`
Expected: FAIL — properties undefined on `Env`.

- [ ] **Step 3: Extend the schema in `env.ts`**

Add to the `EnvSchema` object in `apps/server/src/env.ts` (keep existing fields):

```ts
  // Worker / executor configuration. Absent scratch path -> STREAM-only (no staged/parallel).
  SCHRODUMP_SCRATCH_PATH: z.string().min(1).optional(),
  SCHRODUMP_SCRATCH_MAX_BYTES: z.coerce.number().int().default(107374182400), // 100 GiB
  SCHRODUMP_MAX_CONCURRENT_STAGED: z.coerce.number().int().default(2),
  SCHRODUMP_EXECUTOR_NETWORK: z.string().default("schrodump_targets"),
  WORKER_POLL_MS: z.coerce.number().int().default(2000),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/server && pnpm exec vitest run src/env.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/env.ts apps/server/src/env.test.ts
git commit -m "feat(server): read scratch/executor/worker configuration from env"
```

---

## Task 5: Real assembly — `worker-wiring.ts` (`WorkerStore` + `JobExecutor`)

This task is the runtime "ligação". It composes existing pieces; it needs Docker + S3 + a target DB, so it is **not** unit-tested — it is verified by typecheck and the dev smoke (Task 7). Follow `jobs/backup-wiring.ts` and `jobs/verify-wiring.ts` as the templates; do not re-implement the pipeline.

**Files:**
- Create: `apps/server/src/jobs/worker-wiring.ts`

**Interfaces:**
- Consumes: `runBackupJob`/`BackupContext`/`BackupPorts` (`jobs/backup.ts`), `createBackupPorts`/`BackupWiringDeps` (`jobs/backup-wiring.ts`), `runVerifyJob`/`VerifyContext` (`jobs/verify.ts`), `createVerifyPorts` (`jobs/verify-wiring.ts`), `claimNextJob` (`jobs/claim.ts`), `resolveAdapter` (`@schrodump/engines/registry`), `resolveRecipients` (`crypto/artifact.ts`), `createDockerRunner` (`@schrodump/runner/runner` re-export in `packages/runner`), `ScratchManager`/`ScratchConfig` (`@schrodump/runner/scratch`), the target-probe engine functions used by `probe/test-connection.ts`, and `driverForDestination` (exported from `server.ts` in Step 1).
- Produces: `createWorkerStore(prisma): WorkerStore`, `createJobExecutor(deps): JobExecutor`, `sanitizeReason(err): string`.

- [ ] **Step 1: Export `driverForDestination` from `server.ts`**

In `apps/server/src/server.ts`, change `async function driverForDestination(` to `export async function driverForDestination(` so the worker wiring reuses the exact same destination→driver construction (it already decrypts the secret with the KEK).

- [ ] **Step 2: Implement the `WorkerStore`**

Create `apps/server/src/jobs/worker-wiring.ts` starting with the store (raw prisma — system process, cross-org):

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Runtime assembly for the worker. Not run in CI (needs Docker + S3 + a target DB); exercised by
// the dev smoke. System process: it reads/writes across organizations, so it uses raw prisma, not
// scopedPrisma. Credentials are decrypted only to be USED (handed to a driver/probe), never shown.

import type { PrismaClient } from "@prisma/client";
import { claimNextJob } from "./claim.js";
import type { JobExecutor, WorkerStore } from "./worker.js";

export function createWorkerStore(prisma: PrismaClient): WorkerStore {
  return {
    claimNextJob: () => claimNextJob(prisma),
    failJob: async (jobId, reason) => {
      await prisma.backupJob.update({
        where: { id: jobId },
        data: { state: "FAILED", finishedAt: new Date(), reason },
      });
    },
    enqueueVerify: async (organizationId, artifactId) => {
      const job = await prisma.backupJob.create({
        data: { organizationId, kind: "VERIFY", state: "PENDING", correlationId: `verify:${artifactId}`, artifactId },
        select: { id: true },
      });
      return job.id;
    },
  };
}

// Conservative: never echo a raw error message (driver errors embed the credential/URI). Keep the
// error name/constructor only.
export function sanitizeReason(err: unknown): string {
  if (err instanceof Error) return `job failed: ${err.name}`;
  return "job failed: unknown error";
}
```

- [ ] **Step 3: Implement `createJobExecutor` (BACKUP path)**

Append to `worker-wiring.ts`. Compose the backup ports exactly as `backup-wiring.ts` expects. `probe()` runs the engine's real probe and adapts its result to `backup.ts`'s `ProbeResult` (`estimatedBytes` = sum of database sizes). Descriptors come from `resolveAdapter(engine)`. `persistArtifact` writes the row **born UNOBSERVED** and stamps the job SUCCEEDED via `setState`. Read `backup-wiring.ts`, `backup.ts` (the `BackupContext`/`BackupPorts`/`ProbeResult` shapes) and `probe/test-connection.ts` (the `DEFAULT_PROBES` map + `ProbeConnection`) before writing this so every field name matches. The executor:

```ts
import { createBackupPorts } from "./backup-wiring.js";
import { runBackupJob, type ProbeResult } from "./backup.js";
import { createVerifyPorts } from "./verify-wiring.js";
import { runVerifyJob, type VerifyLevel } from "./verify.js";
import { resolveAdapter } from "@schrodump/engines/registry";
import { resolveRecipients } from "../crypto/artifact.js";
import { decryptCredential, parseEncryptedCredential } from "../crypto/envelope.js";
import { createDockerRunner } from "@schrodump/runner/runner";
import { ScratchManager } from "@schrodump/runner/scratch";
import { driverForDestination } from "../server.js";
import type { BackupResult, ClaimedJob, JobExecutor } from "./worker.js";
import type { Env } from "../env.js";

export interface JobExecutorDeps {
  prisma: PrismaClient;
  kek: Buffer;
  env: Env;
}

export function createJobExecutor(deps: JobExecutorDeps): JobExecutor {
  const runner = createDockerRunner();
  const scratch =
    deps.env.SCHRODUMP_SCRATCH_PATH !== undefined
      ? new ScratchManager({
          root: deps.env.SCHRODUMP_SCRATCH_PATH,
          maxConcurrentStaged: deps.env.SCHRODUMP_MAX_CONCURRENT_STAGED,
        })
      : null;

  const runBackup = async (job: ClaimedJob): Promise<BackupResult> => {
    // 1. Load policy + target + destination (raw prisma — cross-org system process).
    //    (policyId is guaranteed non-null for BACKUP jobs; see Task 1 enqueue fix.)
    // 2. Decrypt target credential (deps.kek) — used, never shown.
    // 3. driver = await driverForDestination(deps.prisma, deps.kek, job.organizationId, destinationId).
    // 4. recipients via resolveRecipients over active EncryptionKey rows for the org.
    // 5. adapter = resolveAdapter(target.engine); descriptors via adapter.buildDump/buildGlobalsDump.
    // 6. Assemble BackupWiringDeps -> createBackupPorts -> runBackupJob(ctx, ports).
    //    - ctx.scratchConfigured = scratch !== null; reserveScratch delegates to scratch.reserve.
    //    - persistArtifact writes the Artifact row (state UNOBSERVED, sizes from UploadResult) AND
    //      links job.artifactId? No — the produced artifact uses jobId; return its id.
    //    - setState updates BackupJob.state/startedAt/finishedAt/reason.
    // 7. Return { ok: outcome.ok, artifactId: outcome.artifactId, verifyLevel: policy.verifyLevel }.
    throw new Error("implement per the composition above");
  };

  const runVerify = async (job: ClaimedJob): Promise<void> => {
    // 1. artifact = prisma.artifact.findUniqueOrThrow({ where: { id: job.artifactId! } }).
    // 2. destination -> sealed = destination.sealMode === 'sealed'.
    // 3. verifyLevel from the artifact's producing policy (via artifact.job.policyId); fallback CHECKSUM.
    // 4. driver = driverForDestination(...); createVerifyPorts({ driver, bucketKey, manifestChecksum,
    //    runFullRestore, setJobState, setArtifactState }).
    // 5. runVerifyJob({ jobId: job.id, artifactId: artifact.id, verifyLevel, sealed }, ports).
    throw new Error("implement per the composition above");
  };

  return { runBackup, runVerify };
}
```

> The composition comments above name every collaborator and its source. This step's deliverable is replacing the two `throw`s with the assembly, matching field names to `backup.ts`/`verify.ts`/`backup-wiring.ts`. Because it needs Docker/S3/a target, its correctness is proven by the dev smoke in Task 7, not a unit test.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (Resolve any signature mismatch against the template files before moving on.)

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/jobs/worker-wiring.ts apps/server/src/server.ts
git commit -m "feat(server): assemble the real worker store and job executor"
```

---

## Task 6: Boot integration, poll loop, and graceful shutdown

**Files:**
- Create: `apps/server/src/jobs/worker-loop.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/src/jobs/worker-loop.test.ts`

**Interfaces:**
- Consumes: `drainQueue`/`WorkerDeps` (`worker.ts`), `withAdvisoryLock`/`pgAdvisoryLock` (`scheduler/advisory-lock.ts`), `recoverOrphanedJobs`/`SchedulerStore` (`scheduler/scheduler.ts`), `createWorkerStore`/`createJobExecutor`/`sanitizeReason` (`worker-wiring.ts`).
- Produces: `startWorker(opts: { drainQueue, intervalMs }): { stop(): void }`, `installShutdown(handlers: { onSignal }): void`.

- [ ] **Step 1: Write the failing test for the loop control**

Create `apps/server/src/jobs/worker-loop.test.ts` (pure timer/control logic, no DB):

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import { startWorker } from "./worker-loop.js";

describe("startWorker", () => {
  it("drains on each tick and stops cleanly", async () => {
    const drainQueue = vi.fn(() => Promise.resolve(1));
    const handle = startWorker({ drainQueue, intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 25));
    handle.stop();
    const callsAtStop = drainQueue.mock.calls.length;
    expect(callsAtStop).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(drainQueue.mock.calls.length).toBe(callsAtStop); // no ticks after stop
  });

  it("never overlaps drains", async () => {
    let active = 0;
    let sawOverlap = false;
    const drainQueue = vi.fn(async () => {
      active += 1;
      if (active > 1) sawOverlap = true;
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return 0;
    });
    const handle = startWorker({ drainQueue, intervalMs: 1 });
    await new Promise((r) => setTimeout(r, 40));
    handle.stop();
    expect(sawOverlap).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/server && pnpm exec vitest run src/jobs/worker-loop.test.ts`
Expected: FAIL — cannot resolve `./worker-loop.js`.

- [ ] **Step 3: Implement `worker-loop.ts`**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export interface StartWorkerOpts {
  drainQueue: () => Promise<number>;
  intervalMs: number;
}

// Polls on an interval, draining the queue each tick. Re-entrancy guarded so a slow drain never
// overlaps the next tick. stop() halts further ticks; an in-flight drain finishes on its own.
export function startWorker(opts: StartWorkerOpts): { stop(): void } {
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void opts
      .drainQueue()
      .catch(() => 0)
      .finally(() => {
        running = false;
      });
  }, opts.intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export interface ShutdownHandlers {
  onSignal(): Promise<void> | void;
}

// Installs SIGTERM/SIGINT once. The handler stops claiming and releases resources before exit.
export function installShutdown(handlers: ShutdownHandlers): void {
  let shuttingDown = false;
  const handle = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.resolve(handlers.onSignal()).finally(() => process.exit(0));
  };
  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/server && pnpm exec vitest run src/jobs/worker-loop.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the worker into `main()`**

In `apps/server/src/server.ts`, after `await app.listen(...)`, add the boot sequence. Build a `SchedulerStore`-shaped object for orphan recovery (only `failRunningJobs` is needed) and start the worker under the advisory lock so a single replica drains:

```ts
  // --- worker boot ---
  // 1. Orphan recovery: a RUNNING job at boot belongs to a process that died.
  const recovered = await prisma.backupJob.updateMany({
    where: { state: "RUNNING" },
    data: { state: "FAILED", finishedAt: new Date(), reason: "orphaned by process restart" },
  });
  if (recovered.count > 0) logger.info({ count: recovered.count }, "recovered orphaned jobs");

  // 2. Single-flight worker (advisory lock keeps one replica draining).
  const WORKER_LOCK_KEY = 0x5343_4852_444d_5031n; // "SCHRDMP1"
  const store = createWorkerStore(prisma);
  const executor = createJobExecutor({ prisma, kek, env });
  const workerDeps = { store, executor, log: logger, sanitizeReason };
  const lock = pgAdvisoryLock(prisma);
  const handle = startWorker({
    intervalMs: env.WORKER_POLL_MS,
    drainQueue: () => withAdvisoryLock(lock, WORKER_LOCK_KEY, () => drainQueue(workerDeps)).then((n) => n ?? 0),
  });

  // 3. Graceful shutdown: stop the loop before exit (scratch of an in-flight job is released by
  //    the ScratchManager the executor holds; full mid-dump cancel is the runner's timeout path).
  installShutdown({ onSignal: () => { handle.stop(); } });
```

Add the imports at the top of `server.ts`:

```ts
import { drainQueue } from "./jobs/worker.js";
import { startWorker, installShutdown } from "./jobs/worker-loop.js";
import { createWorkerStore, createJobExecutor, sanitizeReason } from "./jobs/worker-wiring.js";
import { pgAdvisoryLock, withAdvisoryLock } from "./scheduler/advisory-lock.js";
```

- [ ] **Step 6: Typecheck, lint, full test**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS (new unit tests included; integration/gated stay skipped).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/jobs/worker-loop.ts apps/server/src/jobs/worker-loop.test.ts apps/server/src/server.ts
git commit -m "feat(server): start the job worker on boot with orphan recovery and graceful shutdown"
```

---

## Task 7: Dev end-to-end smoke

Not a code task — the proof that the heart beats. Runs against the local dev stack.

- [ ] **Step 1: Stand up the dependencies**

- Dev Postgres (`schrodump-pg`, port 5433) — already used by the dev stack.
- MinIO for S3 (an S3-compatible destination): `docker run -d --name schrodump-minio -p 9000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 minio/minio server /data`; create a bucket.
- A **target** Postgres with seed data to back up (a second container on the executor network).
- The executor network: `docker network create schrodump_targets` (matches `SCHRODUMP_EXECUTOR_NETWORK`).
- Build the executor images referenced by the engine adapters if not present (`docker/executors/`).
- Configure a scratch dir and set `SCHRODUMP_SCRATCH_PATH`, `SCHRODUMP_EXECUTOR_NETWORK`, `DOCKER_HOST` (socket) for the server process.
- Configure an age keypair and seed `EncryptionKey` rows (operational + escrow) for the org.

- [ ] **Step 2: Drive it**

Log in, create a destination (MinIO) + run its canary, create a target (the seed Postgres) + test-connection, create a policy with `verifyLevel = CHECKSUM`, click "Run backup now".

- [ ] **Step 3: Observe the state machine**

- `GET /jobs`: the BACKUP job goes `PENDING → RUNNING → SUCCEEDED`.
- `GET /artifacts`: an artifact appears, born `UNOBSERVED`.
- A chained VERIFY job appears and reaches `SUCCEEDED`; the artifact flips to `VERIFIED` (green) on the dashboard.

Expected: the dashboard's primary counter drops the artifact from "unobserved" to "verified".

> If an external dependency (executor image, age tooling) proves impractical this session, record exactly which step blocked and fall back to relying on the unit + gated-integration coverage; do not claim the smoke passed if it did not.

---

## Follow-ups (out of scope, tracked for later)

1. Cron auto-dispatch: a tick calling `dispatchDueJobs` under the same advisory lock; wire `recoverOrphanedJobs` via the real `SchedulerStore`.
2. Restore execution (the `POST /artifacts/:id/restore` `501`).
3. Worker concurrency (`SCHRODUMP_MAX_CONCURRENT_STAGED > 1` claiming N jobs).
4. Extract the worker into its own process/entrypoint child.
5. Update `apps/server/CLAUDE.md` (remove the "no consumer loop" / "env gap" notes) and `docs/roadmap.md` (restore still 501; worker now runs) once this lands.
