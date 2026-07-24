# Job worker — design

- **Date:** 2026-07-24
- **Status:** approved, ready for implementation plan
- **Scope of this iteration:** end-to-end (the orchestration brain **and** the real runtime
  wiring), same process as the API, worker + manual trigger + boot orphan recovery. Cron
  auto-dispatch and restore execution are explicit follow-ups.

## Problem

The product's thesis is that a backup is not trusted until a restore has verified it. Today the
API only ever **enqueues** work: `POST /policies/:id/backup` and `POST /artifacts/:id/verify`
create a `BackupJob` in state `PENDING` (`apps/server/src/routes/wiring.ts`), and **nothing
consumes it**. The container runs two processes — the API and the web — and neither the worker
loop nor the scheduler is started (`apps/server/src/server.ts` never imports `scheduler/`). The
pure job logic (`runBackupJob`, `runVerifyJob`) and its real port wiring
(`createBackupPorts`, `createVerifyPorts`) exist and are exercised only by the gated integration
tests. So no artifact is ever produced, and nothing ever leaves `UNOBSERVED`. The heart does not
beat.

This iteration builds the consumer: it claims `PENDING` jobs, executes them against real Docker
executors and S3, and chains a backup into a verify so an artifact can reach `VERIFIED`.

## Goals

- A manually-triggered backup runs end-to-end: `PENDING` → claimed → executed
  (dump → compress → encrypt → upload) → an `Artifact` row born `UNOBSERVED`.
- On a successful backup, if the policy's `verifyLevel != NONE`, a follow-up `VERIFY` job is
  enqueued and consumed; `runVerifyJob` promotes the artifact to `VERIFIED` or `FAILED`.
- A manually-triggered verify (`POST /artifacts/:id/verify`) runs the same way.
- On boot, orphaned `RUNNING` jobs (from a process that died) are marked `FAILED`.
- Only one worker drains at a time across replicas (single-flight via a Postgres advisory lock).
- Graceful `SIGTERM`: stop claiming, release scratch, exit — closing the "cleartext scratch left
  on restart" gap for the worker's own in-flight job.

## Non-goals (this iteration)

- **Cron auto-dispatch.** `dispatchDueJobs` stays unwired; backups are triggered manually. Small
  follow-up (a tick under the same advisory lock).
- **Restore execution.** `POST /artifacts/:id/restore` stays `501`; no `RESTORE` job is enqueued,
  so the worker never sees one.
- **Concurrency.** The worker drains **serially** (one job at a time). A parallelism knob
  (`SCHRODUMP_MAX_CONCURRENT_STAGED`) is a follow-up.
- **Separate worker process.** The loop runs in the API process. Extracting it to its own process
  later is a clean lift because the loop is a plain function.

## Existing building blocks (reused, not rebuilt)

| Piece | Location | Role |
| --- | --- | --- |
| `runBackupJob(ctx, ports)` | `jobs/backup.ts:85` | Pure 11-step pipeline; artifact born `UNOBSERVED`. |
| `createBackupPorts(deps)` | `jobs/backup-wiring.ts:54` | Real ports: runner + storage + age + manifest. |
| `runVerifyJob(ctx, ports)` | `jobs/verify.ts:33` | Sole authority over `VERIFIED`/`FAILED`. |
| `createVerifyPorts(deps)` | `jobs/verify-wiring.ts:25` | Real verify ports. |
| `recoverOrphanedJobs(store)` | `scheduler/scheduler.ts:59` | `RUNNING` → `FAILED` at boot. |
| `withAdvisoryLock` / `pgAdvisoryLock` | `scheduler/advisory-lock.ts` | `pg_try_advisory_lock` single-flight. |
| `Runner` / `createDockerRunner()` | `packages/runner` (`docker.ts:118`) | Docker execution; reads `DOCKER_HOST`. |
| `ScratchManager.reserve(jobId, bytes)` | `packages/runner` (`scratch.ts:64`) | Scratch reservation + sweep. |
| `resolveRecipients(keys)` | `crypto/artifact.ts:51` | age recipients from `EncryptionKey` rows. |
| `driverForDestination(...)` | `server.ts:27` | Builds the S3 driver from a destination (decrypts secret). |
| Engine adapters / registry | `packages/engines` (`descriptor.ts`, `registry`) | Build dump/globals descriptors. |

The gap is the **runtime assembler** that turns a claimed job + DB rows into these ports and runs
them, plus the **loop**, the **claim**, the **chaining**, and the **boot wiring**.

## Design

### 1. Data model (one migration)

- Add `artifactId String?` to `BackupJob` (nullable, indexed, relation to `Artifact`). A `VERIFY`
  job references its artifact **structurally** instead of parsing `correlationId`
  (`verify:${artifactId}`). `BACKUP` jobs leave it null.
- Fix enqueue in `createJobsService` (`routes/wiring.ts`):
  - `enqueueBackup` must set **`policyId`** — today it only sets `correlationId`, so the worker
    could not find the policy (target/destination/verifyLevel). The route
    `POST /policies/:id/backup` already has the id.
  - `enqueueVerify` must set **`artifactId`**.

### 2. Claim (atomic, no double-run)

A store method `claimNextJob(): Promise<ClaimedJob | null>` using the canonical Postgres queue
claim:

```sql
UPDATE "BackupJob"
   SET state = 'RUNNING', "startedAt" = now()
 WHERE id = (
   SELECT id FROM "BackupJob"
    WHERE state = 'PENDING'
    ORDER BY "createdAt" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
 )
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` makes concurrent claims safe and lets the design scale to N workers later
without change. Returns the claimed row (now `RUNNING`) or `null` when the queue is empty.

### 3. The loop (`jobs/worker.ts`)

- `runWorkerOnce(deps): Promise<"ran" | "idle">` — claim one job; if none, return `"idle"`.
  Dispatch by `kind`. Any throw is caught and turned into a terminal `FAILED` with a sanitized
  reason, and scratch is released. Pure and unit-testable with a fake claim + fake executors (no
  Docker, no DB).
- `startWorker(deps)` — a poll loop: drain while `runWorkerOnce` returns `"ran"`, then sleep a
  short interval and poll again. Re-entrancy guarded so only one iteration runs at a time. Started
  from `main()` after `app.listen`, wrapped in the advisory lock so a single replica drains.

### 4. Dispatch + runtime assembly

**BACKUP** (`kind === "BACKUP"`, has `policyId`):
1. Load policy → `targetId`, `destinationId`, `verifyLevel`, `executionMode`, `parallelism`.
2. Load target; decrypt its credential with the KEK (used, never shown).
3. Build the S3 driver via `driverForDestination`.
4. `resolveRecipients` over the org's active `EncryptionKey` rows (operational + escrow).
5. Instantiate `createDockerRunner()` and a `ScratchManager` from env config.
6. Build dump/globals descriptors via the engine adapter from the registry.
7. Assemble `BackupWiringDeps` → `createBackupPorts` → `runBackupJob`.
8. On success with an `artifactId`: if `policy.verifyLevel != NONE`, **enqueue a `VERIFY` job**
   for that artifact (chaining, section 5).

**VERIFY** (`kind === "VERIFY"`, has `artifactId`):
1. Load artifact → destination (`sealMode` → `sealed`), `bucketKey`, `manifestKey`, checksum.
2. Resolve `verifyLevel` from the artifact's originating policy; fall back to `CHECKSUM` for an
   ad-hoc/manual verify with no policy.
3. Build the driver; assemble `VerifyPorts` (`checksumMatches` downloads + recomputes vs the
   manifest; `fullRestore` runs an ephemeral container) → `runVerifyJob`. This is the only place
   an artifact reaches `VERIFIED`/`FAILED`.

**RESTORE** — out of scope; the worker never sees one this iteration.

### 5. Chaining backup → verify

After a `BACKUP` job succeeds and produces an artifact, the worker enqueues a **separate**
`VERIFY` job (state `PENDING`, `artifactId` set) rather than verifying inline. Rationale: every
unit of work is an observable row, it survives a restart, and it reuses the same
claim/dispatch/state path. The loop picks it up on the next drain.

### 6. Boot integration + env

- In `main()` (`server.ts`), after `app.listen`: run `recoverOrphanedJobs` (RUNNING → FAILED,
  "orphaned by process restart"), then `startWorker(...)` under `withAdvisoryLock`. A new
  `jobs/worker-wiring.ts` assembles the worker deps from `prisma`, `kek`, the storage factory and
  the runner, mirroring how `server.ts` already builds `driverForDestination` and the jobs
  service.
- `env.ts` gains (with defaults): `SCHRODUMP_SCRATCH_PATH`, `SCHRODUMP_SCRATCH_MAX_BYTES`,
  `SCHRODUMP_MAX_CONCURRENT_STAGED`, `SCHRODUMP_EXECUTOR_NETWORK`, `DOCKER_HOST` (already consumed
  by `dockerFromEnv`). When scratch is not configured, the worker reports `scratchConfigured =
  false` and only `STREAM` mode is available (no staged/parallel path). This closes the documented
  env gap in `apps/server/CLAUDE.md`.

### 7. Graceful shutdown (SIGTERM)

Install a `SIGTERM`/`SIGINT` handler in the API process: stop claiming new jobs, let the in-flight
job reach a terminal state (or leave it to boot recovery), release scratch via the
`ScratchManager`, then exit. This closes the known gap where a restart leaves an in-flight job's
cleartext scratch on disk until the next boot sweep. Full mid-dump cancellation stays the runner's
timeout/kill responsibility.

## State machine

Job: `PENDING` → (claim) → `RUNNING` → `SUCCEEDED` | `FAILED`. `CANCELLED` is not produced this
iteration. Boot recovery forces stray `RUNNING` → `FAILED`.

Artifact: created `UNOBSERVED` by backup; only `runVerifyJob` moves it to `VERIFIED` or `FAILED`.
A backup under a `verifyLevel = NONE` policy leaves the artifact `UNOBSERVED` permanently — the
central behavior of the product, preserved.

## Testing

- **Unit (no Docker/DB):** `runWorkerOnce` — dispatch by kind, backup→verify chaining, and
  failure → terminal `FAILED` — with a fake claim and fake job executors.
- **Claim:** an integration-style test against the dev Postgres asserting `FOR UPDATE SKIP LOCKED`
  claims exactly once under concurrent callers.
- **Runtime assembly:** covered by the existing gated integration path for `createBackupPorts` /
  `createVerifyPorts`.
- **Dev end-to-end (manual smoke):** stand up MinIO + a target Postgres with seed data + the
  executor images + an age keypair; trigger a backup; watch the job reach `SUCCEEDED`, the
  artifact born `UNOBSERVED`, then the chained verify reach `VERIFIED`.

## Risks / open questions

- The engine → executor images (mydumper, age) must be present for real execution; the dev smoke
  may need to build them from `docker/executors/`.
- Compression (gzip) and encryption (age) run on the API event loop in same-process mode.
  Acceptable for v1; a separate worker process is the mitigation if it bites.
- `verifyLevel` for a manual verify with no originating policy defaults to `CHECKSUM` — confirm
  that default is acceptable.
- If a dev end-to-end piece proves impractical this session, fall back to a documented manual
  smoke and rely on unit + gated integration coverage.

## Out of scope / follow-ups

1. Cron auto-dispatch (`dispatchDueJobs` on a tick under the advisory lock).
2. Restore execution (the `501`).
3. Worker concurrency (`SCHRODUMP_MAX_CONCURRENT_STAGED > 1`).
4. Extracting the worker into its own process.
