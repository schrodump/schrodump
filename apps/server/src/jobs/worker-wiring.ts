// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Runtime assembly for the worker. Not run in CI (needs Docker + S3 + a target DB); exercised by
// the dev smoke. System process: it reads/writes across organizations, so it uses raw prisma, not
// scopedPrisma — every query therefore filters organizationId explicitly. Credentials are decrypted
// only to be USED (handed to a driver/probe), never shown, logged, or returned.

import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { EngineKind } from "@schrodump/core/types";
import type { Manifest } from "@schrodump/core/manifest";
import { resolveAdapter } from "@schrodump/engines/registry";
import type { TargetConnection } from "@schrodump/engines/descriptor";
import { probeMongodb } from "@schrodump/engines/probe/mongodb";
import { probeMysql } from "@schrodump/engines/probe/mysql";
import { probePostgres } from "@schrodump/engines/probe/postgres";
import type { ProbeConnection, ProbeResult as EngineProbeResult } from "@schrodump/engines/probe/types";
import { createDockerRunner } from "@schrodump/runner/runner";
import { ScratchManager } from "@schrodump/runner/scratch";
import { resolveRecipients, type EncryptionKeyRecord } from "../crypto/artifact.js";
import { decryptCredential, parseEncryptedCredential } from "../crypto/envelope.js";
import type { Env } from "../env.js";
import { createBackupPorts } from "./backup-wiring.js";
import { runBackupJob, type ProbeResult } from "./backup.js";
import { claimNextJob } from "./claim.js";
import { driverForDestination } from "./destination-driver.js";
import { createVerifyPorts } from "./verify-wiring.js";
import { runVerifyJob, type VerifyLevel } from "./verify.js";
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

const ScopeSchema = z.object({ databases: z.array(z.string()).default([]) });

type EngineProbeFn = (conn: ProbeConnection) => Promise<EngineProbeResult>;

// mariadb shares the mysql probe; adding an engine is one entry here, mirroring the registry.
const PROBES: Record<EngineKind, EngineProbeFn> = {
  postgres: probePostgres,
  mysql: probeMysql,
  mariadb: probeMysql,
  mongodb: probeMongodb,
};

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
// policy), and whether that level was degraded. FULL_RESTORE is downgraded to CHECKSUM because the
// restore executor it needs is a documented v1 gap (restore returns 501); running CHECKSUM and
// recording the downgrade keeps a good artifact VERIFIED instead of corrupting the central
// UNOBSERVED/VERIFIED/FAILED distinction by failing it against a verifier that does not exist.
export function resolveVerifyPlan(policyLevel: VerifyLevel | null): VerifyPlan {
  const requested: VerifyLevel = policyLevel ?? "CHECKSUM";
  if (requested === "FULL_RESTORE") {
    return {
      effectiveLevel: "CHECKSUM",
      downgradeReason: "restore executor unavailable: FULL_RESTORE downgraded to CHECKSUM",
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
      persistArtifact: async ({ probe, recipients, upload }): Promise<string> => {
        const artifact = await prisma.artifact.create({
          data: {
            organizationId: job.organizationId,
            jobId: job.id,
            destinationId: policy.destinationId,
            state: "UNOBSERVED",
            bucketKey: upload.bucketKey,
            manifestKey: upload.manifestKey,
            engine,
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
      include: { destination: true, job: true },
    });

    const producingJob = artifact.job;
    const policyLevel =
      producingJob.policyId === null
        ? null
        : ((
            await prisma.backupPolicy.findUnique({
              where: { id: producingJob.policyId },
              select: { verifyLevel: true },
            })
          )?.verifyLevel ?? null);
    const plan = resolveVerifyPlan(policyLevel);
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

    const ports = createVerifyPorts({
      driver: destination.driver,
      bucketKey: artifact.bucketKey,
      // The checksum recorded at upload IS the manifest's checksum of the stored object.
      manifestChecksum: artifact.checksum,
      // FULL_RESTORE is downgraded to CHECKSUM in the plan above, so this is unreachable; it stays
      // honest about the v1 gap rather than pretending to verify.
      runFullRestore: () => Promise.reject(new Error("FULL_RESTORE verify is not wired in v1")),
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

  return { runBackup, runVerify };
}
