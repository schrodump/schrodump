// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Runtime assembly for the worker. Not run in CI (needs Docker + S3 + a target DB); exercised by
// the dev smoke. System process: it reads/writes across organizations, so it uses raw prisma, not
// scopedPrisma — every query therefore filters organizationId explicitly. Credentials are decrypted
// only to be USED (handed to a driver/probe), never shown, logged, or returned.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { EngineKind } from "@schrodump/core/types";
import type { Manifest } from "@schrodump/core/manifest";
import { resolveAdapter } from "@schrodump/engines/registry";
import type { DumpScope, TargetConnection } from "@schrodump/engines/descriptor";
import { probeMongodb } from "@schrodump/engines/probe/mongodb";
import { probeMysql } from "@schrodump/engines/probe/mysql";
import { probePostgres } from "@schrodump/engines/probe/postgres";
import type { ProbeConnection, ProbeResult as EngineProbeResult } from "@schrodump/engines/probe/types";
import { createDockerRunner, type RunMount } from "@schrodump/runner/runner";
import { ScratchManager } from "@schrodump/runner/scratch";
import {
  resolveDecryptionKeyId,
  resolveRecipients,
  type EncryptionKeyRecord,
} from "../crypto/artifact.js";
import { decryptCredential, parseEncryptedCredential } from "../crypto/envelope.js";
import { writeMongoConfig } from "../crypto/mongo-config.js";
import type { Env } from "../env.js";
import { createBackupPorts } from "./backup-wiring.js";
import { runBackupJob, type ProbeResult } from "./backup.js";
import { claimNextJob } from "./claim.js";
import { driverForDestination } from "./destination-driver.js";
import type { ExecutionMode } from "./execution-mode.js";
import {
  artifactBelongsToOrg,
  globalsKeyFor,
  restoreParamsOf,
  restoreScopeOf,
  runRestorePipeline,
} from "./restore-executor.js";
import { createRestorePorts, type RestoreWiringDeps } from "./restore-wiring.js";
import { runRestoreJob } from "./restore.js";
import { classifyVerifyError, createVerifyPorts } from "./verify-wiring.js";
import { runVerifyJob, type VerifyLevel, type VerifyProof } from "./verify.js";
import type { BackupResult, ClaimedJob, JobExecutor, WorkerStore } from "./worker.js";

// Identifies the tool that produced a manifest. No per-build version source exists yet (the server
// package is 0.0.0); a stable literal keeps the manifest schema satisfied until one lands.
const TOOL_VERSION = "schrodump-server/0.0.0";
// The pipeline always gzips the dump before encryption (see backup-wiring.ts), regardless of the
// policy's compression preference — the manifest and artifact must record what actually happened.
const PIPELINE_COMPRESSION = "gzip" as const;
const ARTIFACT_ENCRYPTION_ALGORITHM = "age";
// A backup preflight, not a UI click: a little more slack than test-connection's 8s.
const PROBE_CONNECT_TIMEOUT_MS = 15_000;
// Coarse ceiling for an executor run. There is no per-job timeout knob in the v1 env; a generous
// bound still guards against a wedged container holding the worker forever.
const DUMP_TIMEOUT_MS = 3 * 60 * 60 * 1000;
// Bounds readiness polling for the ephemeral verify sandbox (passed as readinessTimeoutMs). A
// throwaway postgres container should accept connections within seconds; this is generous slack,
// not a target. It does NOT bound the sandbox's lifetime — that's the `use` callback (restore runs
// under DUMP_TIMEOUT_MS), with teardown in withEphemeralService's finally.
const SANDBOX_READY_TIMEOUT_MS = 60_000;

const ScopeSchema = z.object({ databases: z.array(z.string()).default([]) });

// Restore writes the decrypted CLEARTEXT dump to disk; it MUST land on the configured scratch volume
// (gc-swept, and host-encrypted in the deploy), never a tmpdir fallback. The decryption identity is
// NOT written to disk — it decrypts in-process, in memory. The reservation estimate stays a small
// nominal placeholder: v1 restore is single-stream with no size-based staging, so the dump is not
// pre-sized against free space here (see the deferred "scratch dump-file sizing" item in the roadmap).
const DUMP_SCRATCH_BYTES = 4096;
const RESTORE_SCRATCH_REQUIRED_REASON =
  "restore requires a configured scratch path for the decrypted dump";
// Mongo delivers the dump/restore password through a bind-mounted `--config` file (off argv). A
// RunMount.source must be a Docker-daemon path, so that file has to live on the shared scratch
// volume — mongo backup therefore requires scratch, and says so plainly instead of failing deep in
// the executor. The reservation is tiny (the file is a single `password:` line).
const MONGO_CONFIG_SCRATCH_REQUIRED_REASON =
  "mongodb backup requires a configured scratch path for the --config credential file";

type EngineProbeFn = (conn: ProbeConnection) => Promise<EngineProbeResult>;

// mariadb shares the mysql probe; adding an engine is one entry here, mirroring the registry.
const PROBES: Record<EngineKind, EngineProbeFn> = {
  postgres: probePostgres,
  mysql: probeMysql,
  mariadb: probeMysql,
  mongodb: probeMongodb,
};

export function createWorkerStore(prisma: PrismaClient, signal?: AbortSignal): WorkerStore {
  return {
    // Once the shutdown signal trips, claim nothing new: handle.stop() only halts NEW ticks, but the
    // in-flight drainQueue while-loop keeps calling claimNextJob. Without this guard it would claim
    // and (on the already-aborted signal) FAIL every queued PENDING job during the grace window —
    // terminal FAILEDs the scheduler won't recreate. Returning null makes drainQueue go idle and exit
    // right after the aborted in-flight job, leaving the rest PENDING for the next boot.
    claimNextJob: () => (signal?.aborted === true ? Promise.resolve(null) : claimNextJob(prisma)),
    failJob: async (jobId, reason) => {
      await prisma.backupJob.update({
        where: { id: jobId },
        data: { state: "FAILED", finishedAt: new Date(), reason },
      });
    },
    enqueueVerify: async (organizationId, artifactId) => {
      const job = await prisma.backupJob.create({
        data: {
          organizationId,
          kind: "VERIFY",
          state: "PENDING",
          correlationId: `verify:${artifactId}`,
          artifactId,
        },
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

// Pure adapter from the RICH engine probe to backup.ts's ProbeResult. estimatedBytes is the sum of
// per-database sizes the probe measured (testTargetConnection drops these — the worker must not).
export function toBackupProbe(rich: EngineProbeResult): ProbeResult {
  return {
    serverVersionNum: rich.serverVersionNum,
    scope: rich.scope,
    estimatedBytes: rich.databases.reduce((sum, database) => sum + database.sizeBytes, 0),
  };
}

export interface VerifyPlan {
  // The level verify actually runs at.
  effectiveLevel: VerifyLevel;
  // Non-null when the requested level was degraded — recorded on the job so the downgrade is
  // visible, exactly like verify.ts's sealed-destination downgrade.
  downgradeReason: string | null;
}

// The plan a VERIFY job runs under: the originating policy's level (CHECKSUM when there is no
// policy), and whether that level was degraded. FULL_RESTORE reuses the STREAM-only restore
// pipeline (restore.ts's gate), so it is downgraded to CHECKSUM for a STAGED artifact of ANY engine:
// running CHECKSUM and recording the downgrade keeps a good artifact VERIFIED instead of corrupting
// the central UNOBSERVED/VERIFIED/FAILED distinction by failing it against a restore pipeline that
// cannot run for that artifact yet. STREAM keeps FULL_RESTORE (wired via runFullRestore) EXCEPT for
// an UNSCOPED non-postgres artifact (see below). The sealed-destination downgrade lives in the
// domain (runVerifyJob) and is orthogonal to this one.
//
// Why an UNSCOPED non-postgres artifact downgrades too — a different reason than STAGED. For these
// engines an unscoped artifact is a MULTI-DATABASE archive, but the verify sandbox restores it and
// then counts objects in the SINGLE origin db originDatabaseFor resolves — which, unscoped, collapses
// to a SYSTEM db that never holds the restored app data, so the assertion's count is unrelated to
// whether the data actually landed:
//   - mysql/mariadb: an unscoped mysqldump embeds `USE <db>` per user database; originDatabaseFor
//     collapses to the "mysql" SYSTEM db, whose ~30 always-present system tables make the table
//     count >= 1 REGARDLESS of whether any user data restored → a FALSE VERIFIED.
//   - mongodb: mongodump --archive on a replica set is a full-instance archive (mongodb.ts's buildDump
//     REFUSES a scoped dump on a replica set — MONGODB_OPLOG_REQUIRES_FULL_DUMP — so every replica set
//     is forced unscoped); originDatabaseFor collapses to "admin", which holds only system collections
//     and the bootstrapped `verify` root user. An empty admin would FAIL a good backup; a populated
//     admin.system.users would VERIFY one that never proved the app data landed.
// Both blur VERIFIED/FAILED, so both downgrade to CHECKSUM — the same honest deferral as STAGED: a
// good unscoped artifact stays VERIFIED via CHECKSUM instead of getting a wrong verdict. A SCOPED
// target (a non-empty database in scope) has a real origin db and keeps FULL_RESTORE.
//
// POSTGRES is exempt: its -Fc dump is db-name-agnostic and restores into the fixed "verify" sandbox
// db, where the assertion counts ALL non-system schemas — so it needs no scope and cannot hit this
// system-db collapse.
export function resolveVerifyPlan(
  policyLevel: VerifyLevel | null,
  engine: EngineKind,
  executionMode: ExecutionMode,
  scopedDatabases: string[],
): VerifyPlan {
  const requested: VerifyLevel = policyLevel ?? "CHECKSUM";
  if (requested === "FULL_RESTORE" && executionMode === "STAGED") {
    return {
      effectiveLevel: "CHECKSUM",
      downgradeReason: "STAGED artifacts cannot be FULL_RESTORE-verified in v1: downgraded to CHECKSUM",
    };
  }
  // An empty-string db name is not a real scope entry: the route rejects it (targets.ts .min(1)).
  // "Scoped" is judged EXACTLY as originDatabaseFor resolves the origin db — the FIRST entry, non-
  // empty — so the two can never disagree over what a legacy/malformed [""] (or [""].concat(...))
  // stored scope means. Were this to read [""] as scoped while originDatabaseFor collapses to the
  // system db, we would keep FULL_RESTORE and mint the exact false VERIFIED above.
  const firstScoped = scopedDatabases[0];
  const isScoped = firstScoped !== undefined && firstScoped.length > 0;
  if (requested === "FULL_RESTORE" && engine !== "postgres" && !isScoped) {
    return {
      effectiveLevel: "CHECKSUM",
      downgradeReason: `unscoped ${engine} artifacts cannot be FULL_RESTORE-verified in v1 (multi-database archive): downgraded to CHECKSUM`,
    };
  }
  return { effectiveLevel: requested, downgradeReason: null };
}

// The database the probe/dump connects THROUGH. For SQL engines it is a real database (the first
// scoped one, else the engine default); for MongoDB `database` is the auth source, always admin.
function probeDatabaseFor(engine: EngineKind, scopedDatabases: string[]): string {
  if (engine === "mongodb") return "admin";
  const first = scopedDatabases[0];
  if (first !== undefined && first.length > 0) return first;
  return engine === "postgres" ? "postgres" : "mysql";
}

// The artifact's ORIGIN database — the db mysql/mongo restore INTO (mysqldump's `USE <origin>` / the
// mongodump archive's embedded db names), resolved from the producing target's scope exactly as the
// backup path chose its dump db: the first scoped database, else the engine default a single-db dump
// used. UNLIKE probeDatabaseFor, mongo does NOT collapse to "admin" when scoped — that helper reports
// the authSource, whereas THIS is the real data db the verify assertion must inspect. Only the unscoped
// mongo fallback is "admin" (a full-instance archive has no single origin db — the multi-db case is a
// deferred follow-up), so a scoped mongo target resolves its actual db here.
export function originDatabaseFor(engine: EngineKind, scopedDatabases: string[]): string {
  const first = scopedDatabases[0];
  if (first !== undefined && first.length > 0) return first;
  if (engine === "postgres") return "postgres";
  if (engine === "mongodb") return "admin";
  return "mysql";
}

// How the verify sandbox connection and the assertion scope differ per engine. They COINCIDE for
// postgres/mysql (the connection authenticates against, and the assertion inspects, the same db) but
// DIVERGE for mongo: the bootstrap root user `verify` lives in `admin`, so the connection MUST
// authenticate against the admin authSource, while the restored data lands in the origin db. The
// origin db therefore reaches mongo's assertion through `scope.databases[0]` (which buildVerifyAssertions
// reads to pick which db to count collections in), never through the connection's `database` — putting
// it there would authenticate against a non-existent user db and fail even with the right password.
export interface VerifyEngineWiring {
  // The sandbox connection's `database`: the admin authSource for mongo, the fixed "verify" db for
  // postgres, the origin db (pre-created by MYSQL_DATABASE) for mysql/mariadb.
  readonly connectionDatabase: string;
  // The scope handed to buildVerifyAssertions. Only mongo needs a populated scope (the origin db);
  // mysql counts connection.database and postgres counts the connected verify db, so both read empty.
  readonly assertionScope: DumpScope;
}

export function verifyEngineWiring(
  engine: EngineKind,
  sandboxDatabase: string,
  originDatabase: string,
): VerifyEngineWiring {
  if (engine === "mongodb") {
    return {
      connectionDatabase: "admin",
      assertionScope: { databases: [originDatabase], schemas: [], collections: [] },
    };
  }
  return {
    connectionDatabase: sandboxDatabase,
    assertionScope: { databases: [], schemas: [], collections: [] },
  };
}

function toKeyRecord(row: {
  keyId: string;
  type: "operational" | "escrow";
  publicRecipient: string;
  state: "active" | "retired";
}): EncryptionKeyRecord {
  return {
    keyId: row.keyId,
    type: row.type,
    publicRecipient: row.publicRecipient,
    state: row.state,
  };
}

export interface JobExecutorDeps {
  prisma: PrismaClient;
  kek: Buffer;
  env: Env;
  // The shutdown signal (Task 4 constructs the real AbortController and passes it here). A
  // construction-time dependency, bound once and forwarded into every container-creating call this
  // executor makes — directly and through the backup/restore ports — never threaded through the
  // worker brain (drainQueue/runWorkerOnce). Undefined outside a shutdown: unchanged behavior.
  signal?: AbortSignal;
}

export function createJobExecutor(deps: JobExecutorDeps): JobExecutor {
  const prisma = deps.prisma;
  const runner = createDockerRunner();
  const scratch =
    deps.env.SCHRODUMP_SCRATCH_PATH !== undefined
      ? new ScratchManager({
          root: deps.env.SCHRODUMP_SCRATCH_PATH,
          maxConcurrentStaged: deps.env.SCHRODUMP_MAX_CONCURRENT_STAGED,
        })
      : null;

  const failJob = async (jobId: string, reason: string): Promise<void> => {
    await prisma.backupJob.update({
      where: { id: jobId },
      data: { state: "FAILED", finishedAt: new Date(), reason },
    });
  };

  const setJobState = async (
    jobId: string,
    state: "RUNNING" | "SUCCEEDED" | "FAILED",
    reason?: string,
  ): Promise<void> => {
    await prisma.backupJob.update({
      where: { id: jobId },
      data: {
        state,
        ...(state === "RUNNING" ? { startedAt: new Date() } : { finishedAt: new Date() }),
        ...(reason !== undefined ? { reason } : {}),
      },
    });
  };

  const runBackup = async (job: ClaimedJob): Promise<BackupResult> => {
    // A BACKUP job without a policy has no target/destination to work from (Task 1 guarantees one;
    // this is the structural guard for a corrupt row, mirroring the verify orphan below).
    if (job.policyId === null) {
      await failJob(job.id, "backup job has no associated policy");
      return { ok: false, artifactId: null, verifyLevel: "NONE" };
    }

    const policy = await prisma.backupPolicy.findUniqueOrThrow({
      where: { id: job.policyId },
      select: { targetId: true, destinationId: true, verifyLevel: true, parallelism: true },
    });
    const target = await prisma.databaseTarget.findUniqueOrThrow({
      where: { id: policy.targetId },
    });

    const destination = await driverForDestination(prisma, deps.kek, job.organizationId, policy.destinationId);
    if (destination === null) {
      await failJob(job.id, "backup destination unavailable");
      return { ok: false, artifactId: null, verifyLevel: "NONE" };
    }

    const engine = target.engine;
    const adapter = resolveAdapter(engine);
    const scopeParse = ScopeSchema.safeParse(target.scope);
    const scopedDatabases = scopeParse.success ? scopeParse.data.databases : [];
    const connectDatabase = probeDatabaseFor(engine, scopedDatabases);

    // Decrypt the credential to USE it — hand it to the probe/driver. It never leaves this scope.
    const password = decryptCredential(deps.kek, parseEncryptedCredential(target.encryptedCredential));

    // The RICH probe runs here, outside the pipeline, so a probe failure is sanitized by the worker
    // (sanitizeReason) instead of being written verbatim into BackupJob.reason via the pipeline's
    // FAILED path — driver probe errors embed the credential/URI. Its facts also feed the dump
    // descriptors, which backup.ts's ProbeResult does not carry.
    const richProbe = await PROBES[engine]({
      host: target.host,
      port: target.port,
      database: connectDatabase,
      username: target.username,
      password,
      tls: target.tls,
      connectTimeoutMs: PROBE_CONNECT_TIMEOUT_MS,
    });
    const backupProbe = toBackupProbe(richProbe);
    const facts = richProbe.facts;

    const connection: TargetConnection = {
      host: target.host,
      port: target.port,
      database: connectDatabase,
      username: target.username,
      password,
      tls: target.tls,
    };

    // Mongo's password reaches mongodump ONLY through a bind-mounted `--config` file (never argv);
    // every other engine passes it via env and mounts nothing. That file is a cleartext credential,
    // so it lives on the scratch volume (0700 reserved dir, 0644 file, gc-swept, deploy-encrypted) and
    // is removed in the finally around runBackupJob. Mongo is STREAM-only (stagedCapable:false), so
    // runBackupJob never takes a STAGED reservation on this job id — no collision with this one.
    let mongoConfigMount: RunMount | undefined;
    let releaseMongoConfig: (() => Promise<void>) | null = null;
    if (engine === "mongodb") {
      if (scratch === null) {
        await failJob(job.id, MONGO_CONFIG_SCRATCH_REQUIRED_REASON);
        return { ok: false, artifactId: null, verifyLevel: "NONE" };
      }
      const reservation = await scratch.reserve(job.id, DUMP_SCRATCH_BYTES);
      // Assigned IMMEDIATELY once the reservation exists, so a throw from writeMongoConfig below
      // (ENOSPC/EIO on the writeFile/chmod) still releases the semaphore slot via the catch — a
      // leaked reservation wedges every future staged operation (a small SCHRODUMP_MAX_CONCURRENT_
      // STAGED, 1 in practice, makes this permanent) until process restart. gc() reclaims the
      // directory by age but never touches the semaphore, so it cannot recover a leaked slot.
      releaseMongoConfig = () => reservation.release();
      try {
        const configFile = await writeMongoConfig(reservation.path, password);
        mongoConfigMount = configFile.mount;
        releaseMongoConfig = async () => {
          await configFile.cleanup();
          await reservation.release();
        };
      } catch (err) {
        await releaseMongoConfig();
        throw err;
      }
    }

    const startedAt = Date.now();
    const stagingPathFor = (): string | undefined =>
      deps.env.SCHRODUMP_SCRATCH_PATH !== undefined
        ? join(deps.env.SCHRODUMP_SCRATCH_PATH, job.id)
        : undefined;

    const ports = createBackupPorts({
      jobId: job.id,
      organizationId: job.organizationId,
      engine,
      runner,
      driver: destination.driver,
      network: deps.env.SCHRODUMP_EXECUTOR_NETWORK,
      prefix: destination.prefix,
      timeoutMs: DUMP_TIMEOUT_MS,
      // Only mongodb sets this; the mount carries the `--config` password file into mongodump.
      ...(mongoConfigMount !== undefined ? { configMount: mongoConfigMount } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      setState: (state, reason) => setJobState(job.id, state, reason),
      probe: () => Promise.resolve(backupProbe),
      reserveScratch: async (estimatedBytes) => {
        // Unreachable unless STAGED was chosen, which requires scratch to be configured.
        if (scratch === null) throw new Error("scratch is not configured on this deploy");
        return scratch.reserve(job.id, estimatedBytes);
      },
      resolveRecipients: async () => {
        const keys = await prisma.encryptionKey.findMany({
          where: { organizationId: job.organizationId },
        });
        return resolveRecipients(keys.map(toKeyRecord));
      },
      buildDumpDescriptor: (mode, parallelism, probe) => {
        const stagingPath = mode === "STAGED" ? stagingPathFor() : undefined;
        return adapter.buildDump({
          connection,
          serverVersionNum: probe.serverVersionNum,
          executionMode: mode,
          parallelism,
          scope: probe.scope,
          facts,
          ...(stagingPath !== undefined ? { stagingPath } : {}),
        });
      },
      buildGlobalsDescriptor: (probe) =>
        adapter.buildGlobalsDump === undefined
          ? null
          : adapter.buildGlobalsDump({
              connection,
              serverVersionNum: probe.serverVersionNum,
              executionMode: "STREAM",
              parallelism: 1,
              scope: probe.scope,
              facts,
            }),
      buildManifest: ({ probe, mode, recipients, upload }): Manifest => ({
        manifestVersion: 1,
        jobId: job.id,
        organizationId: job.organizationId,
        engine,
        serverVersionNum: probe.serverVersionNum,
        toolVersion: TOOL_VERSION,
        executionMode: mode,
        parallelism: mode === "STAGED" ? policy.parallelism : 1,
        scope: probe.scope,
        sizeRawBytes: upload.sizeRawBytes,
        sizeCompressedBytes: upload.sizeCompressedBytes,
        checksumAlgorithm: upload.checksumAlgorithm,
        checksum: upload.checksum,
        compression: PIPELINE_COMPRESSION,
        encryption: { algorithm: ARTIFACT_ENCRYPTION_ALGORITHM, keyIds: recipients.keyIds },
        dependsOn: [],
        createdAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
      }),
      persistArtifact: async ({ probe, mode, recipients, upload }): Promise<string> => {
        const artifact = await prisma.artifact.create({
          data: {
            organizationId: job.organizationId,
            jobId: job.id,
            destinationId: policy.destinationId,
            state: "UNOBSERVED",
            bucketKey: upload.bucketKey,
            manifestKey: upload.manifestKey,
            engine,
            executionMode: mode,
            serverVersionNum: probe.serverVersionNum,
            sizeRawBytes: BigInt(upload.sizeRawBytes),
            sizeCompressedBytes: BigInt(upload.sizeCompressedBytes),
            checksumAlgorithm: upload.checksumAlgorithm,
            checksum: upload.checksum,
            compression: PIPELINE_COMPRESSION,
            keyIds: recipients.keyIds,
            dependsOn: [],
          },
          select: { id: true },
        });
        return artifact.id;
      },
    });

    try {
      const outcome = await runBackupJob(
        {
          jobId: job.id,
          organizationId: job.organizationId,
          requestedParallelism: policy.parallelism,
          // No dedicated staged-threshold knob in v1: the scratch budget doubles as the size above
          // which a single-threaded dump prefers staging. Explicit parallelism still forces STAGED.
          stagedThresholdBytes: deps.env.SCHRODUMP_SCRATCH_MAX_BYTES,
          scratchConfigured: scratch !== null,
        },
        ports,
      );

      return { ok: outcome.ok, artifactId: outcome.artifactId, verifyLevel: policy.verifyLevel };
    } finally {
      // Remove the mongo `--config` credential file (and release its reservation) whether the dump
      // succeeded or threw; a no-op for the other engines.
      if (releaseMongoConfig !== null) await releaseMongoConfig();
    }
  };

  const runVerify = async (job: ClaimedJob): Promise<void> => {
    // ON DELETE SET NULL: the artifact this job targeted was deleted. An orphaned verify job is
    // failed with a clear reason, never silently skipped.
    if (job.artifactId === null) {
      await failJob(job.id, "verify target artifact no longer exists");
      return;
    }

    const artifact = await prisma.artifact.findUniqueOrThrow({
      where: { id: job.artifactId },
      // The producing job's policy → target carries the origin scope FULL_RESTORE needs to resolve
      // the origin db for the mysql/mongo verify sandbox (postgres ignores it). A policy-less
      // producer (self-backup) leaves policy/target null → an unscoped origin, handled below.
      include: {
        destination: true,
        job: { include: { policy: { include: { target: true } } } },
      },
    });

    // SECURITY: the VERIFY job must reference an artifact in its OWN organization. This runs on raw
    // prisma (system process), so the check is explicit and happens BEFORE any decrypt — mirroring
    // runRestore's guard below. A job pointing at another org's artifact is failed, never verified;
    // the artifact itself is left untouched (it is not this org's artifact to judge).
    if (!artifactBelongsToOrg(artifact.organizationId, job.organizationId)) {
      await failJob(job.id, "verify artifact does not belong to this organization");
      return;
    }

    const producingJob = artifact.job;
    // Org-scoped even though the id is transitively this org's already (the artifact was ownership-
    // checked above): the worker's convention is that every raw-prisma query filters organizationId
    // explicitly, so the filter is stated, not inferred.
    const policyLevel =
      producingJob.policyId === null
        ? null
        : ((
            await prisma.backupPolicy.findFirst({
              where: { id: producingJob.policyId, organizationId: job.organizationId },
              select: { verifyLevel: true },
            })
          )?.verifyLevel ?? null);
    // The origin scope the producing target was scoped to, parsed up front (rather than only inside
    // runFullRestore) so resolveVerifyPlan can see it: an UNSCOPED mongo artifact needs its own
    // downgrade (see resolveVerifyPlan) distinct from the STAGED one. A policy-less producer or a
    // malformed stored scope degrades to unscoped (never throws) — this is verify, not restore.
    const originScope = ScopeSchema.safeParse(producingJob.policy?.target?.scope);
    const scopedDatabases = originScope.success ? originScope.data.databases : [];
    const plan = resolveVerifyPlan(policyLevel, artifact.engine, artifact.executionMode, scopedDatabases);
    const sealed = artifact.destination.sealMode === "sealed";

    const destination = await driverForDestination(
      prisma,
      deps.kek,
      job.organizationId,
      artifact.destinationId,
    );
    if (destination === null) {
      await failJob(job.id, "verify destination unavailable");
      return;
    }

    // Gathered the same way the RESTORE dispatch does: the engine adapter drives buildVerifySandbox /
    // buildRestore / buildVerifyAssertions for the FULL_RESTORE path below (unused on CHECKSUM).
    const engine = artifact.engine;
    const adapter = resolveAdapter(engine);

    const ports = createVerifyPorts({
      driver: destination.driver,
      bucketKey: artifact.bucketKey,
      // The checksum recorded at upload IS the manifest's checksum of the stored object.
      manifestChecksum: artifact.checksum,
      // FULL_RESTORE (any STREAM artifact — the plan downgrades only STAGED to CHECKSUM). Restore the
      // artifact into a THROWAWAY container of its own engine/major on the isolated executor network,
      // assert the schema landed, then destroy it. The catch is TOTAL: every throw path is mapped by
      // classifyVerifyError to FAILED (the artifact is bad) or INCONCLUSIVE (our infra failed) — a raw
      // throw must NEVER escape to runVerifyJob's catch, which would mark a possibly-good artifact
      // FAILED and violate the leave-it-UNOBSERVED-on-infra-failure thesis.
      runFullRestore: async (): Promise<VerifyProof> => {
        // ONE outer try makes the catch total: every throw — buildVerifySandbox on an out-of-range
        // major, a prisma/decrypt error while loading the identity, a runner/S3/executor error inside
        // withEphemeralService — is funnelled to classifyVerifyError. The three-way result is the ONLY
        // way this port returns; it never rethrows to runVerifyJob (which would mark the artifact
        // FAILED on our own infra failure). The pre-flight guards below `return "INCONCLUSIVE"` for the
        // gracefully-degradable cases before any container is even started.
        try {
          const sandboxPassword = randomUUID();
          // The origin db the artifact restores INTO, resolved from the producing target's scope the
          // same way the backup chose its dump db (originDatabaseFor). scopedDatabases was already
          // parsed above (outside this closure) so resolveVerifyPlan could see it too; reused here
          // rather than re-parsed. A policy-less producer or a malformed stored scope degrades to an
          // unscoped origin (engine default) rather than throwing — this is verify, not restore: never
          // condemn a good artifact over a scope parse.
          const originDatabase = originDatabaseFor(engine, scopedDatabases);

          // buildVerifySandbox is optional (only engines with an in-process restore implement it).
          // Undefined means an engine that slipped past the plan downgrade — INCONCLUSIVE. Third arg
          // is the origin db: postgres ignores it (its -Fc dump is db-name-agnostic, fixed "verify"
          // sandbox db); mysql pre-creates it via MYSQL_DATABASE; mongo reports it back for the
          // assertion scope (its restore lands in the archive's own db names).
          const sandbox = adapter.buildVerifySandbox?.(
            artifact.serverVersionNum,
            sandboxPassword,
            originDatabase,
          );
          if (sandbox === undefined) return "INCONCLUSIVE";

          // Per-engine split: which db the sandbox connection authenticates against vs. which db the
          // assertion inspects. Coincide for postgres/mysql; diverge for mongo (auth against admin,
          // count collections in the origin db). See verifyEngineWiring.
          const wiring = verifyEngineWiring(engine, sandbox.database, originDatabase);

          // The decrypted CLEARTEXT dump MUST stage on the scratch volume (exactly as restore
          // requires); no scratch configured → cannot run the test → INCONCLUSIVE. (scratchManager
          // re-binds the const so the nested reserveStaging closure sees it narrowed to non-null.)
          if (scratch === null) return "INCONCLUSIVE";
          const scratchManager = scratch;

          // Materialize the operational age identity IN MEMORY (KEK-decrypted, never on disk), exactly
          // as runRestore does. A missing/corrupt-row identity is graceful degradation (INCONCLUSIVE),
          // never an artifact FAILED. Sealed artifacts are downgraded to CHECKSUM upstream by the
          // domain (VerifyContext.sealed); this null-identity path is the defensive backstop.
          // ALL keys (active + retired): the artifact may have been encrypted with a now-retired key.
          const keys = await prisma.encryptionKey.findMany({
            where: { organizationId: job.organizationId },
          });
          const keyId = resolveDecryptionKeyId(artifact.keyIds, keys.map(toKeyRecord));
          if (keyId === null) return "INCONCLUSIVE";
          const keyRow = await prisma.encryptionKey.findFirst({
            where: { organizationId: job.organizationId, keyId },
          });
          if (keyRow === null || keyRow.encryptedIdentity === null) return "INCONCLUSIVE";
          const ageIdentity = decryptCredential(
            deps.kek,
            parseEncryptedCredential(keyRow.encryptedIdentity),
          );

          // The RESTORE descriptors take an empty scope: verify restores the WHOLE artifact into a
          // fresh sandbox, never a sub-scope. Each engine's restore already knows where the data
          // lands — postgres -Fc is db-name-agnostic (fixed "verify" db), mysqldump embeds
          // `USE <origin>`, and the mongodump archive carries its own db names — so no scope is
          // needed here. The ASSERTION scope (wiring.assertionScope) is separate: mongo alone needs
          // the origin db there to know which restored db to count collections in.
          const restoreScope: DumpScope = { databases: [], schemas: [], collections: [] };

          return await runner.withEphemeralService(
            {
              image: sandbox.image,
              env: sandbox.env,
              network: deps.env.SCHRODUMP_EXECUTOR_NETWORK,
              readinessCommand: sandbox.readinessCommand,
              port: sandbox.port,
              readinessTimeoutMs: SANDBOX_READY_TIMEOUT_MS,
              correlationId: job.id,
            },
            async ({ host }): Promise<VerifyProof> => {
              const conn: TargetConnection = {
                host,
                port: sandbox.port,
                username: sandbox.username,
                // TLS off: a localhost-equivalent link on an isolated network to a container that
                // lives seconds; the password is a per-verify throwaway.
                password: sandboxPassword,
                // Per-engine (verifyEngineWiring): postgres → fixed "verify" db; mysql → the origin
                // db MYSQL_DATABASE pre-created; mongo → the "admin" authSource the root `verify`
                // user lives in (NOT the origin db — that would break authentication).
                database: wiring.connectionDatabase,
                tls: false,
              };

              // globals first (roles/tablespaces), then the per-database artifact. runRestorePipeline
              // resolves true or THROWS a typed SchrodumpError (mapped by the outer catch).
              await runRestorePipeline({
                driver: destination.driver,
                runner,
                bucketKey: artifact.bucketKey,
                globalsKey: globalsKeyFor(engine, artifact.serverVersionNum, artifact.bucketKey),
                ageIdentity,
                network: deps.env.SCHRODUMP_EXECUTOR_NETWORK,
                timeoutMs: DUMP_TIMEOUT_MS,
                correlationId: job.id,
                ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
                buildRestoreDescriptor: (sourcePath) =>
                  adapter.buildRestore({
                    connection: conn,
                    serverVersionNum: artifact.serverVersionNum,
                    target: "FULL_CLUSTER",
                    scope: restoreScope,
                    executionMode: artifact.executionMode,
                    sourcePath,
                  }),
                buildGlobalsRestoreDescriptor: (sourcePath) =>
                  adapter.buildGlobalsRestore === undefined
                    ? null
                    : adapter.buildGlobalsRestore({
                        connection: conn,
                        serverVersionNum: artifact.serverVersionNum,
                        target: "FULL_CLUSTER",
                        scope: restoreScope,
                        executionMode: artifact.executionMode,
                        sourcePath,
                      }),
                reserveStaging: async () => {
                  const reservation = await scratchManager.reserve(job.id, DUMP_SCRATCH_BYTES);
                  return { dir: reservation.path, cleanup: () => reservation.release() };
                },
                // Mongo's mongorestore reads its password from the mounted `--config` file (off argv),
                // so it needs the same materialize-into-staging mount the real restore path uses; here
                // the credential is the sandbox's throwaway root password (conn.password), and the
                // config authenticates the `verify` root user against admin. runRestorePipeline
                // materializes it INSIDE its try and sweeps it before releasing the dir, so a
                // materialization throw still releases the reservation (never a leaked semaphore slot).
                // Other engines carry the password in env → no mount.
                ...(engine === "mongodb"
                  ? {
                      provideExtraMounts: async (dir: string) => {
                        const configFile = await writeMongoConfig(dir, conn.password);
                        return { mounts: [configFile.mount], cleanup: configFile.cleanup };
                      },
                    }
                  : {}),
              });

              // Restore landed. Assert a usable schema: count the restored user tables. Collect the
              // executor's stdout through a PassThrough (as backup-wiring collects a run's stream);
              // run() resolves only after stdout is fully piped, so every chunk has arrived here.
              const assertOut = new PassThrough();
              const chunks: Buffer[] = [];
              assertOut.on("data", (chunk: Buffer) => chunks.push(chunk));
              const assertRun = await runner.run(
                adapter.buildVerifyAssertions({
                  connection: conn,
                  serverVersionNum: artifact.serverVersionNum,
                  // mongo counts collections in scope.databases[0] (the origin db); mysql counts
                  // connection.database; postgres counts the connected verify db. verifyEngineWiring
                  // populates the origin db for mongo and leaves it empty for the others.
                  scope: wiring.assertionScope,
                }),
                {
                  network: deps.env.SCHRODUMP_EXECUTOR_NETWORK,
                  mounts: [],
                  stdout: assertOut,
                  timeoutMs: DUMP_TIMEOUT_MS,
                  correlationId: job.id,
                  ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
                },
              );
              const count = Number.parseInt(Buffer.concat(chunks).toString("utf8").trim(), 10);
              // VERIFIED iff the assertion exited clean AND found at least one user table; anything
              // else is a restore that produced no usable schema → FAILED (a claim about the artifact).
              return assertRun.exitCode === 0 && Number.isFinite(count) && count >= 1
                ? "VERIFIED"
                : "FAILED";
            },
            deps.signal !== undefined ? { signal: deps.signal } : undefined,
          );
        } catch (err) {
          // TOTAL catch: typed restore/runner codes → FAILED (artifact) vs INCONCLUSIVE (our infra);
          // any unrecognized throw defaults to INCONCLUSIVE (never condemn a backup on a surprise).
          return classifyVerifyError(err);
        }
      },
      // Surface the downgrade: verify.ts marks a passing CHECKSUM as ("SUCCEEDED", undefined); when
      // we degraded FULL_RESTORE, rewrite that one terminal call so BackupJob.reason records why.
      setJobState: (state, reason) => {
        const withDowngrade =
          plan.downgradeReason !== null && state === "SUCCEEDED" && reason === undefined
            ? plan.downgradeReason
            : reason;
        return setJobState(job.id, state, withDowngrade);
      },
      setArtifactState: async (state) => {
        await prisma.artifact.update({ where: { id: artifact.id }, data: { state } });
      },
    });

    await runVerifyJob(
      { jobId: job.id, artifactId: artifact.id, verifyLevel: plan.effectiveLevel, sealed },
      ports,
    );
  };

  const runRestore = async (job: ClaimedJob): Promise<void> => {
    const params = restoreParamsOf(job.restoreParams);

    // I1: restore writes the decrypted CLEARTEXT dump to disk. Only the scratch volume is swept by
    // ScratchManager.gc() (and host-encrypted in the deploy); without it we would strand a plaintext
    // copy of the org's data on an unswept, possibly unencrypted filesystem. A configured scratch path
    // is mandatory; never fall back to tmpdir. (The identity itself never touches disk — in-process.)
    if (scratch === null) {
      await failJob(job.id, RESTORE_SCRATCH_REQUIRED_REASON);
      return;
    }

    if (job.artifactId === null) {
      await failJob(job.id, "restore job has no target artifact");
      return;
    }

    const artifact = await prisma.artifact.findUnique({
      where: { id: job.artifactId },
      include: {
        destination: true,
        job: { include: { policy: { include: { target: true } } } },
      },
    });
    if (artifact === null) {
      await failJob(job.id, "restore target artifact no longer exists");
      return;
    }

    // SECURITY: the RESTORE job must reference an artifact in its OWN organization. This runs on raw
    // prisma (system process), so the check is explicit and happens BEFORE any decrypt. A job
    // pointing at another org's artifact is failed, never restored.
    if (!artifactBelongsToOrg(artifact.organizationId, job.organizationId)) {
      await failJob(job.id, "restore artifact does not belong to this organization");
      return;
    }

    // The origin target is reached through the producing job's policy. A policy-less producer
    // (manual/self-backup) has no target to restore into — a clear failure, not a guess.
    const originTarget = artifact.job.policy?.target ?? null;
    if (originTarget === null) {
      await failJob(job.id, "cannot resolve the origin target for this artifact");
      return;
    }

    const destination = await driverForDestination(
      prisma,
      deps.kek,
      job.organizationId,
      artifact.destinationId,
    );
    if (destination === null) {
      await failJob(job.id, "restore destination unavailable");
      return;
    }

    const engine = artifact.engine;
    const adapter = resolveAdapter(engine);
    // M1: a malformed scope fails loud — never silently degrade to an empty scope, which would
    // restore the wrong (empty) set. The parse failure carries only zod field paths, no credential.
    let scope;
    try {
      scope = restoreScopeOf(originTarget.scope);
    } catch {
      await failJob(job.id, "restore origin target has a malformed scope");
      return;
    }
    const connectDatabase = probeDatabaseFor(engine, scope.databases);

    const connectionFor = (password: string): TargetConnection => ({
      host: originTarget.host,
      port: originTarget.port,
      database: connectDatabase,
      username: originTarget.username,
      password,
      tls: originTarget.tls,
    });

    const wiringDeps: RestoreWiringDeps = {
      loadArtifactRow: () =>
        Promise.resolve({
          manifestKeyIds: artifact.keyIds,
          engine,
          executionMode: artifact.executionMode,
          serverVersionNum: artifact.serverVersionNum,
          destinationName: artifact.destination.name,
        }),
      availableKeys: async () => {
        // ALL keys (active + retired): an artifact may have been encrypted with a now-retired key.
        const keys = await prisma.encryptionKey.findMany({
          where: { organizationId: job.organizationId },
        });
        return keys.map(toKeyRecord);
      },
      targetHasExistingData: async () => {
        // C1 (security): the engine probes propagate the RAW driver error by contract — the server
        // sanitizes, not the engines — and the Mongo driver embeds the full connection URI (password
        // included) in that message. runRestoreJob catches a throw here and writes error.message
        // straight to BackupJob.reason, bypassing the worker's sanitizeReason. So a raw driver
        // message must NEVER escape: swallow it and re-throw a credential-free error. The credential
        // decrypt lives inside the same guard so an envelope error can't escape raw either.
        let probe;
        try {
          // Decrypt the credential to USE it (probe the origin target), never to show it.
          const password = decryptCredential(
            deps.kek,
            parseEncryptedCredential(originTarget.encryptedCredential),
          );
          probe = await PROBES[engine]({
            host: originTarget.host,
            port: originTarget.port,
            database: connectDatabase,
            username: originTarget.username,
            password,
            tls: originTarget.tls,
            connectTimeoutMs: PROBE_CONNECT_TIMEOUT_MS,
          });
        } catch {
          throw new Error("could not probe the origin target");
        }
        // Conservative signal: any non-empty database in scope (or any probed database when the
        // target is unscoped) counts as "holds data", so the overwrite gate errs toward requiring
        // confirmation. A precise user-data check (table/row counts) is a follow-up; the smoke
        // (Task 5) validates the gate.
        const inScope =
          scope.databases.length > 0
            ? probe.databases.filter((database) => scope.databases.includes(database.name))
            : probe.databases;
        return inScope.some((database) => database.sizeBytes > 0);
      },
      audit: async (event) => {
        await prisma.auditLog.create({
          data: {
            organizationId: job.organizationId,
            userId: event.userId,
            action: event.action,
            targetType: "artifact",
            targetId: event.artifactId,
            correlationId: job.correlationId,
            metadata: { destinationName: event.destinationName, keyId: event.keyId },
          },
        });
      },
      setJobState: (state, reason) => setJobState(job.id, state, reason),
      runRestore: async (keyId: string): Promise<boolean> => {
        // Materialize the operational identity for the key runRestoreJob resolved from the manifest.
        const keyRow = await prisma.encryptionKey.findFirst({
          where: { organizationId: job.organizationId, keyId },
        });
        if (keyRow === null || keyRow.encryptedIdentity === null) {
          // resolveDecryptionKeyId already guaranteed an operational key that carries an identity;
          // this is a structural guard against a corrupt row, not an expected path.
          throw new Error("operational identity unavailable for the resolved key");
        }
        const ageIdentity = decryptCredential(
          deps.kek,
          parseEncryptedCredential(keyRow.encryptedIdentity),
        );
        const password = decryptCredential(
          deps.kek,
          parseEncryptedCredential(originTarget.encryptedCredential),
        );
        const connection = connectionFor(password);

        return runRestorePipeline({
          driver: destination.driver,
          runner,
          bucketKey: artifact.bucketKey,
          globalsKey: globalsKeyFor(engine, artifact.serverVersionNum, artifact.bucketKey),
          ageIdentity,
          network: deps.env.SCHRODUMP_EXECUTOR_NETWORK,
          timeoutMs: DUMP_TIMEOUT_MS,
          correlationId: job.id,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          buildRestoreDescriptor: (sourcePath) =>
            adapter.buildRestore({
              connection,
              serverVersionNum: artifact.serverVersionNum,
              target: params.target,
              scope,
              executionMode: artifact.executionMode,
              sourcePath,
            }),
          buildGlobalsRestoreDescriptor: (sourcePath) =>
            adapter.buildGlobalsRestore === undefined
              ? null
              : adapter.buildGlobalsRestore({
                  connection,
                  serverVersionNum: artifact.serverVersionNum,
                  target: params.target,
                  scope,
                  executionMode: artifact.executionMode,
                  sourcePath,
                }),
          // Mongo restore reads its password from the mounted `--config` file (off argv); the pipeline
          // materializes it into the reserved staging dir (same swept volume as the dump) and removes
          // it before releasing that dir. Other engines carry the password in env → no mount.
          ...(engine === "mongodb"
            ? {
                provideExtraMounts: async (dir: string) => {
                  const configFile = await writeMongoConfig(dir, connection.password);
                  return { mounts: [configFile.mount], cleanup: configFile.cleanup };
                },
              }
            : {}),
          reserveStaging: async () => {
            // I1: reserve the per-job scratch DIRECTORY (ScratchManager.gc() reclaims it if a hard
            // kill skips the finally cleanup; a bare root file would be skipped by gc). It holds the
            // decrypted cleartext dump files (the identity never lands here — decrypt is in-process);
            // runRestorePipeline removes each dump in finally, and release() recursively removes the
            // dir as a backstop.
            const reservation = await scratch.reserve(job.id, DUMP_SCRATCH_BYTES);
            return { dir: reservation.path, cleanup: () => reservation.release() };
          },
        });
      },
    };

    await runRestoreJob(
      {
        jobId: job.id,
        artifactId: artifact.id,
        organizationId: job.organizationId,
        userId: params.triggeredByUserId,
        target: params.target,
        confirmExistingDatabase: params.confirmExistingDatabase,
      },
      createRestorePorts(wiringDeps),
    );
  };

  return { runBackup, runVerify, runRestore };
}
