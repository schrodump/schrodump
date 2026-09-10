// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real, tenant-scoped route wiring. Not run in CI (needs a database, and canary/test-connection
// need S3 / a reachable target). Every store is built from scopedPrisma, so every query is
// automatically filtered by organizationId.

import type { ArtifactState, JobKind, JobState, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { definedOnly } from "../data/patch.js";
import type { Auth } from "../auth/auth.js";
import type { Role } from "../auth/rbac.js";
import { scopedPrisma } from "../data/scope.js";
import type { MemberRecord, MemberStore } from "./members.js";
import { encryptCredential } from "../crypto/envelope.js";
import { readCredential, type CredentialAuditSink } from "../crypto/credential-access.js";
import {
  testTargetConnection,
  type EngineName,
  type TestConnectionResult,
} from "../probe/test-connection.js";
import type { DestinationStore } from "./destinations.js";
import type { ChannelStore, TestDeliveryResult } from "./notifications.js";
import {
  deliverToChannel,
  TEST_NOTIFICATION,
  type ChannelDeliveryDeps,
} from "../notifications/deliver.js";
import type { PolicyRecord, PolicyStore } from "./policies.js";
import { generateAgeKeyPair, recipientFingerprint } from "../crypto/artifact.js";
import type { EncryptionKeyRoutesDeps } from "./encryption-keys.js";
import { LIST_PAGE_SIZE } from "./jobs.js";
import type { ArtifactRecord, JobsService } from "./jobs.js";
import { driverForDestination } from "../jobs/destination-driver.js";
import { globalsObjectKey, restoreTargetOf } from "../jobs/restore-executor.js";
import type { RestoreTarget } from "../jobs/restore.js";

export function prismaDestinationStore(
  prisma: PrismaClient,
  organizationId: string,
): DestinationStore {
  const db = scopedPrisma(prisma, organizationId);
  return {
    create: (data) =>
      db.storageDestination.create({
        data: {
          organizationId,
          name: data.name,
          ...(data.endpoint !== undefined ? { endpoint: data.endpoint } : {}),
          region: data.region,
          bucket: data.bucket,
          prefix: data.prefix,
          accessKeyId: data.accessKeyId,
          encryptedSecretAccessKey: data.encryptedSecretAccessKey,
          forcePathStyle: data.forcePathStyle,
          sealMode: data.sealMode,
        },
      }),
    list: () => db.storageDestination.findMany(),
    get: (id) => db.storageDestination.findFirst({ where: { id } }),
    update: async (id, data) => {
      const { count } = await db.storageDestination.updateMany({
        where: { id },
        data: definedOnly(data),
      });
      if (count === 0) return null;
      return db.storageDestination.findFirst({ where: { id } });
    },
    remove: async (id) => {
      // Artifacts first, because it is the consequential one: this row holds the ONLY credentials
      // the system has for that bucket. Deleting it does not delete the backups — it makes them
      // unreachable, leaving a catalogue of entries nobody can restore from. Refuse, never cascade.
      const artifacts = await db.artifact.count({ where: { destinationId: id } });
      if (artifacts > 0) {
        return {
          ok: false,
          reason: `${artifacts} artifact${artifacts === 1 ? " is" : "s are"} still stored in this destination`,
        };
      }
      const policies = await db.backupPolicy.count({ where: { destinationId: id } });
      if (policies > 0) {
        return {
          ok: false,
          reason: `${policies} backup polic${policies === 1 ? "y" : "ies"} still write to this destination`,
        };
      }
      await db.storageDestination.deleteMany({ where: { id } });
      return { ok: true };
    },
    // updateMany, not update: organizationId stays in the filter, so a destination belonging to
    // another organization is a miss rather than a cross-tenant write — the same shape every other
    // scoped mutation here uses.
    recordCanary: async (id, ok) => {
      await prisma.storageDestination.updateMany({
        where: { id, organizationId },
        data: { lastCanaryAt: new Date(), lastCanaryOk: ok },
      });
    },
  };
}

// BigInt <-> number mapping: the DB stores minAgeBeforeDeleteMs as BigInt; the API uses a number.
function toPolicyRecord(row: {
  id: string;
  name: string;
  targetId: string;
  destinationId: string;
  cron: string;
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  minAgeBeforeDeleteMs: bigint;
  verifyLevel: string;
  executionMode: string;
  parallelism: number;
  compression: string;
  enabled: boolean;
}): PolicyRecord {
  return {
    id: row.id,
    name: row.name,
    targetId: row.targetId,
    destinationId: row.destinationId,
    cron: row.cron,
    keepLast: row.keepLast,
    keepDaily: row.keepDaily,
    keepWeekly: row.keepWeekly,
    keepMonthly: row.keepMonthly,
    keepYearly: row.keepYearly,
    minAgeBeforeDeleteMs: Number(row.minAgeBeforeDeleteMs),
    verifyLevel: row.verifyLevel as PolicyRecord["verifyLevel"],
    executionMode: row.executionMode as PolicyRecord["executionMode"],
    parallelism: row.parallelism,
    compression: row.compression as PolicyRecord["compression"],
    enabled: row.enabled,
  };
}

export function prismaPolicyStore(prisma: PrismaClient, organizationId: string): PolicyStore {
  const db = scopedPrisma(prisma, organizationId);
  return {
    create: async (data) =>
      toPolicyRecord(
        await db.backupPolicy.create({
          data: {
            organizationId,
            name: data.name,
            targetId: data.targetId,
            destinationId: data.destinationId,
            cron: data.cron,
            keepLast: data.keepLast,
            keepDaily: data.keepDaily,
            keepWeekly: data.keepWeekly,
            keepMonthly: data.keepMonthly,
            keepYearly: data.keepYearly,
            minAgeBeforeDeleteMs: BigInt(data.minAgeBeforeDeleteMs),
            verifyLevel: data.verifyLevel,
            executionMode: data.executionMode,
            parallelism: data.parallelism,
            compression: data.compression,
            enabled: data.enabled,
          },
        }),
      ),
    list: async () => (await db.backupPolicy.findMany()).map(toPolicyRecord),
    get: async (id) => {
      const row = await db.backupPolicy.findFirst({ where: { id } });
      return row === null ? null : toPolicyRecord(row);
    },
    update: async (id, data) => {
      const { minAgeBeforeDeleteMs, ...rest } = data;
      const { count } = await db.backupPolicy.updateMany({
        where: { id },
        data: {
          ...definedOnly(rest),
          // number -> BigInt on the way in, the mirror of toPolicyRecord on the way out.
          ...(minAgeBeforeDeleteMs !== undefined
            ? { minAgeBeforeDeleteMs: BigInt(minAgeBeforeDeleteMs) }
            : {}),
        },
      });
      if (count === 0) return null;
      const row = await db.backupPolicy.findFirst({ where: { id } });
      return row === null ? null : toPolicyRecord(row);
    },
    remove: async (id) => {
      // BackupJob.policy is an OPTIONAL relation, so Prisma's default here is SetNull rather than
      // Restrict: the database would accept this delete and quietly blank policyId on every job the
      // policy ever ran. The artifacts those jobs produced would lose their only link back to a
      // policy — unattributable in the catalogue, and permanently invisible to retention, which
      // selects by policyId. Nothing would appear broken, which is what makes it worth refusing.
      const jobs = await db.backupJob.count({ where: { policyId: id } });
      if (jobs > 0) {
        return {
          ok: false,
          reason:
            `${jobs} job${jobs === 1 ? "" : "s"} still reference this policy — ` +
            `disable it instead of deleting it, so its history stays attributable`,
        };
      }
      await db.backupPolicy.deleteMany({ where: { id } });
      return { ok: true };
    },
  };
}

const ScopeSchema = z.object({ databases: z.array(z.string()).default([]) });

// The one place a target credential is decrypted. It is decrypted to be USED — handed to a driver
// that opens a socket — never to be shown: the plaintext stays inside this function's call and
// nothing derived from it reaches the response or the log.
async function probeTarget(
  prisma: PrismaClient,
  kek: Buffer,
  audit: CredentialAuditSink,
  organizationId: string,
  targetId: string,
): Promise<TestConnectionResult> {
  const row = await scopedPrisma(prisma, organizationId).databaseTarget.findFirst({
    where: { id: targetId },
  });
  if (row === null) {
    return {
      ok: false,
      serverVersionNum: null,
      failure: "UNKNOWN",
      driverCode: null,
      databases: [],
      isReplicaSet: null,
    };
  }

  const scope = ScopeSchema.safeParse(row.scope);
  return testTargetConnection({
    engine: row.engine as EngineName,
    host: row.host,
    port: row.port,
    username: row.username,
    password: readCredential({ kek, audit }, row.encryptedCredential, {
      organizationId,
      resource: "target",
      resourceId: row.id,
      purpose: "test connection: probe the target on the operator's request",
      correlationId: `probe:${row.id}`,
    }),
    tls: row.tls,
    databases: scope.success ? scope.data.databases : [],
  });
}

// BigInt -> number: the DB stores artifact sizes as BigInt, which Fastify cannot serialize (it
// throws, and the whole /artifacts response 500s). Narrow them here and drop internal columns.
export function toArtifactRecord(row: {
  id: string;
  jobId: string;
  destinationId: string;
  state: string;
  verifiedLevel: string | null;
  verifiedDegraded: boolean;
  bucketKey: string;
  manifestKey: string;
  engine: string;
  executionMode: string;
  sourceHasOplog: boolean | null;
  dumpIsMultiDatabase: boolean | null;
  serverVersionNum: number;
  sizeRawBytes: bigint;
  sizeCompressedBytes: bigint;
  checksumAlgorithm: string;
  checksum: string;
  compression: string;
  keyIds: string[];
  dependsOn: string[];
  createdAt: Date;
  updatedAt: Date;
  // Loaded through ARTIFACT_SUBJECT_INCLUDE. Optional so a caller that did not ask for the subject
  // still maps; absent or null answers null, never a placeholder.
  job?: { policy: { name: string; target: { name: string } | null } | null } | null;
}): ArtifactRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    destinationId: row.destinationId,
    targetName: row.job?.policy?.target?.name ?? null,
    policyName: row.job?.policy?.name ?? null,
    state: row.state,
    // Passed through as recorded: verifiedLevel is null until a verify reaches a verdict, and a
    // green with verifiedDegraded true is a checksum the operator asked full restore for — the row
    // must be able to say which, so the dashboard does not paint both greens the same.
    verifiedLevel: row.verifiedLevel,
    verifiedDegraded: row.verifiedDegraded,
    bucketKey: row.bucketKey,
    manifestKey: row.manifestKey,
    engine: row.engine,
    // Anything the DB does not spell STAGED is treated as STREAM — the same default the column
    // carries. A widened mode would have to opt into the gate explicitly, not inherit a pass.
    executionMode: row.executionMode === "STAGED" ? "STAGED" : "STREAM",
    // Passed through unchanged, null included: null means "this engine has no oplog", which is a
    // different statement from false ("a mongo dump that carries none") and must stay tellable
    // apart. Coercing either into the other would make the field say something the dump did not.
    sourceHasOplog: row.sourceHasOplog,
    // Passed through unchanged, null included: null means the fact was never recorded, which the
    // restore gate treats as unproven rather than as safe. Coercing it to false would hand the UI
    // permission the server does not give.
    dumpIsMultiDatabase: row.dumpIsMultiDatabase,
    serverVersionNum: row.serverVersionNum,
    sizeRawBytes: Number(row.sizeRawBytes),
    sizeCompressedBytes: Number(row.sizeCompressedBytes),
    checksumAlgorithm: row.checksumAlgorithm,
    checksum: row.checksum,
    compression: row.compression,
    keyIds: row.keyIds,
    dependsOn: row.dependsOn,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// A single JobsService bound to the raw prisma; each method scopes by the passed organizationId.
// The two routes a job takes to the database it is about. `policy` covers BACKUP and RETENTION,
// which belong to one; `verifyArtifact` covers VERIFY and RESTORE, which act on an artifact and
// reach the policy through the job that produced it. Declared once so the query and the mapper
// below cannot drift into disagreeing about which relations were loaded.
export const JOB_SUBJECT_INCLUDE = {
  policy: { select: { name: true, target: { select: { name: true } } } },
  verifyArtifact: {
    select: {
      id: true,
      state: true,
      job: { select: { policy: { select: { name: true, target: { select: { name: true } } } } } },
    },
  },
  // The artifact a BACKUP wrote — null until it has, and for every other kind. With the state
  // riding along, a ledger row can point at what the run left behind and say whether anyone has
  // looked at it yet, without a second request per row.
  artifact: { select: { id: true, state: true } },
} as const;

// An artifact's subject, reached through the job that wrote it: the policy names the run, the
// policy's target says what was backed up. Declared once, like JOB_SUBJECT_INCLUDE, so the query
// and the mapper cannot drift into disagreeing about which relations were loaded.
export const ARTIFACT_SUBJECT_INCLUDE = {
  job: { select: { policy: { select: { name: true, target: { select: { name: true } } } } } },
} as const;

// Nulls are meaningful and are NOT collapsed to a placeholder: a manual backup genuinely has no
// policy, and a job whose policy was deleted genuinely has no target to name. Answering "unknown"
// in the API would make the UI unable to tell "nobody scheduled this" from "the row is gone".
type JobSubjectRelations = {
  policy?: { name: string; target: { name: string } } | null;
  verifyArtifact?: {
    id: string;
    state: ArtifactState;
    job: { policy: { name: string; target: { name: string } } | null };
  } | null;
  artifact?: { id: string; state: ArtifactState } | null;
  restoreParams?: unknown;
};

// The artifact a job is ABOUT: the one a VERIFY or RESTORE acts on, or the one a BACKUP produced.
// One field, because the ledger asks one question of every row — "what did this run touch, and in
// what state did it leave it" — and the answer does not depend on which relation held it.
export interface JobArtifactRef {
  id: string;
  state: ArtifactState;
}

export function toJobRecord<T extends JobSubjectRelations>(
  row: T,
): Omit<T, "policy" | "verifyArtifact" | "artifact"> & {
  policyName: string | null;
  targetName: string | null;
  artifact: JobArtifactRef | null;
  restoreTarget: RestoreTarget | null;
} {
  // The relations come OUT. They were loaded to answer two questions, and returning the nested
  // shape would put a second, differently-spelled copy of the policy on every row for any client
  // that later reads it — the response says what the job is about, not how that was looked up.
  const { policy, verifyArtifact, artifact, ...job } = row;
  const resolved = policy ?? verifyArtifact?.job.policy ?? null;
  const touched = verifyArtifact ?? artifact ?? null;
  return {
    ...job,
    policyName: resolved?.name ?? null,
    targetName: resolved?.target.name ?? null,
    artifact: touched === null ? null : { id: touched.id, state: touched.state },
    restoreTarget: restoreTargetOf(row.restoreParams),
  };
}

export function createJobsService(
  prisma: PrismaClient,
  kek: Buffer,
  audit: CredentialAuditSink,
): JobsService {
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
    // A job row said what KIND it was and nothing about WHAT it was for, so the only handle on
    // "which database is this" was a cuid inside the correlationId. That is the first question
    // anyone asks while a job is running and the only one the screen could not answer — an
    // operator watching two backups had no way to tell which of their databases was being read.
    //
    // The two kinds reach the same answer by different routes: a BACKUP or RETENTION belongs to a
    // policy, which names the target; a VERIFY or RESTORE acts on an artifact, and the artifact
    // knows the job that produced it, which has the policy. Flattened to two strings here rather
    // than returned nested, because the shape the UI needs is "which database, which policy" and
    // nothing about how many hops that took.
    listJobs: async (organizationId) => {
      const db = scopedPrisma(prisma, organizationId);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [rows, total, byStateRows, byKindRows, failedLast24h, inconclusiveLast24h, oldestPending] =
        await Promise.all([
          db.backupJob.findMany({
            orderBy: { createdAt: "desc" },
            take: LIST_PAGE_SIZE,
            include: JOB_SUBJECT_INCLUDE,
          }),
          db.backupJob.count(),
          db.backupJob.groupBy({ by: ["state"], _count: { _all: true } }),
          db.backupJob.groupBy({ by: ["kind"], _count: { _all: true } }),
          db.backupJob.count({ where: { state: "FAILED", finishedAt: { gte: since } } }),
          db.backupJob.count({ where: { state: "INCONCLUSIVE", finishedAt: { gte: since } } }),
          db.backupJob.findFirst({
            where: { state: "PENDING", scheduledAt: { not: null } },
            orderBy: { scheduledAt: "asc" },
            select: { scheduledAt: true },
          }),
        ]);
      // Every member of the enum is present, at zero when absent: the client renders a chip per
      // state and per kind, and a missing key would read as a state the server does not know.
      const byState: Record<JobState, number> = {
        PENDING: 0,
        RUNNING: 0,
        SUCCEEDED: 0,
        FAILED: 0,
        INCONCLUSIVE: 0,
        CANCELLED: 0,
      };
      for (const group of byStateRows) byState[group.state] = group._count._all;
      const byKind: Record<JobKind, number> = { BACKUP: 0, RESTORE: 0, VERIFY: 0, RETENTION: 0 };
      for (const group of byKindRows) byKind[group.kind] = group._count._all;
      return {
        items: rows.map(toJobRecord),
        total,
        counts: { byState, byKind },
        stats: {
          oldestPendingScheduledAt: oldestPending?.scheduledAt ?? null,
          failedLast24h,
          inconclusiveLast24h,
        },
      };
    },
    // The counts come from a groupBy over the WHOLE table, never from `items`. A dashboard that
    // counted the returned page would report "3 unobserved backups" on a deployment with four
    // hundred of them the moment the list got capped — and the unobserved count is the number this
    // entire product leads with. Truncating the list is a rendering decision; truncating that
    // number would be a lie.
    listArtifacts: async (organizationId) => {
      const db = scopedPrisma(prisma, organizationId);
      const [rows, total, grouped, byLevel, byDestination, oldest] = await Promise.all([
        db.artifact.findMany({
          orderBy: { createdAt: "desc" },
          take: LIST_PAGE_SIZE,
          include: ARTIFACT_SUBJECT_INCLUDE,
        }),
        db.artifact.count(),
        db.artifact.groupBy({ by: ["state"], _count: { _all: true } }),
        db.artifact.groupBy({ by: ["verifiedLevel"], where: { state: "VERIFIED" }, _count: { _all: true } }),
        db.artifact.groupBy({ by: ["destinationId"], _count: { _all: true } }),
        // The head of an ascending query, never a page scan: the oldest open question is the
        // one the page is least likely to hold.
        db.artifact.findFirst({
          where: { state: "UNOBSERVED" },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            createdAt: true,
            executionMode: true,
            job: { select: { policy: { select: { target: { select: { name: true } } } } } },
          },
        }),
      ]);
      const counts = { VERIFIED: 0, UNOBSERVED: 0, FAILED: 0 };
      for (const group of grouped) counts[group.state] = group._count._all;
      const verifiedByLevel = { FULL_RESTORE: 0, CHECKSUM: 0 };
      for (const group of byLevel) {
        if (group.verifiedLevel === "FULL_RESTORE" || group.verifiedLevel === "CHECKSUM") {
          verifiedByLevel[group.verifiedLevel] = group._count._all;
        }
      }
      return {
        items: rows.map(toArtifactRecord),
        total,
        counts,
        verifiedByLevel,
        destinations: byDestination.length,
        oldestUnobserved:
          oldest === null
            ? null
            : {
                id: oldest.id,
                createdAt: oldest.createdAt,
                targetName: oldest.job?.policy?.target?.name ?? null,
                executionMode: oldest.executionMode,
              },
      };
    },
    deleteArtifact: async (organizationId, artifactId, opts) => {
      const db = scopedPrisma(prisma, organizationId);
      const artifact = await db.artifact.findFirst({ where: { id: artifactId } });
      // Scoped query: a row in another org reads as absent, and must — the answer to "does this
      // exist for you" is no, not 403 (which would confirm the id to someone who cannot see it).
      if (artifact === null) return { ok: false, reason: "not_found" };
      // A VERIFIED artifact is the one green a restore has actually proven. Refuse to delete it on
      // a bare request; the caller has to acknowledge that is what they are throwing away.
      if (artifact.state === "VERIFIED" && !opts.acknowledgeVerified) {
        return { ok: false, reason: "verified_needs_ack" };
      }
      // Delete the objects first, then the row: a row removed before its objects would orphan the
      // bytes forever (nothing else knows the keys). If the destination is gone the objects are
      // already unreachable — the catalog row must still be removable, so a null driver is not
      // fatal. DeleteObjects treats an absent key as success, so the postgres globals sibling costs
      // nothing for the engines that never wrote one. The delete is recorded against
      // correlationId, mirroring how retention and the worker attribute credential access.
      const resolved = await driverForDestination(prisma, kek, organizationId, artifact.destinationId, {
        audit,
        purpose: `delete artifact ${artifactId}`,
        correlationId: `delete:${artifactId}`,
      });
      if (resolved !== null) {
        await resolved.driver.delete([
          artifact.bucketKey,
          artifact.manifestKey,
          globalsObjectKey(artifact.bucketKey),
        ]);
      }
      await db.artifact.delete({ where: { id: artifactId } });
      return { ok: true };
    },
    // Real dispatch (probe / descriptor / runner composition) is handled by the worker that picks
    // up the PENDING job; here we only enqueue it.
    enqueueBackup: (organizationId, policyId) => enqueue(organizationId, "BACKUP", { policyId }),
    enqueueVerify: (organizationId, artifactId) =>
      enqueue(organizationId, "VERIFY", { artifactId }),
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
    testConnection: (organizationId, targetId) =>
      probeTarget(prisma, kek, audit, organizationId, targetId),
    // updateMany with organizationId in the filter: a target in another organization is a miss,
    // not a cross-tenant write. Only the CODE is stored — `driverCode` and the driver's message
    // stay out of the row, because this column is returned to every viewer and a driver error
    // embeds the credential it failed with.
    recordProbe: async (organizationId, targetId, result) => {
      await prisma.databaseTarget.updateMany({
        where: { id: targetId, organizationId },
        data: { lastProbeAt: new Date(), lastProbeOk: result.ok, lastProbeFailure: result.failure },
      });
    },
  };
}

// Notification channels. Organization-scoped like every other store; the secrets are already
// encrypted by the route before they reach here, and nothing reads them back.
export function prismaNotificationChannelStore(
  prisma: PrismaClient,
  organizationId: string,
): ChannelStore {
  return {
    create: async (data) =>
      prisma.notificationChannel.create({
        data: {
          organizationId,
          kind: data.kind,
          ...(data.url !== undefined ? { url: data.url } : {}),
          ...(data.encryptedSecret !== undefined
            ? { encryptedSecret: JSON.stringify(data.encryptedSecret) }
            : {}),
          ...(data.smtpHost !== undefined ? { smtpHost: data.smtpHost } : {}),
          ...(data.smtpPort !== undefined ? { smtpPort: data.smtpPort } : {}),
          ...(data.smtpUsername !== undefined ? { smtpUsername: data.smtpUsername } : {}),
          ...(data.encryptedSmtpPassword !== undefined
            ? { encryptedSmtpPassword: JSON.stringify(data.encryptedSmtpPassword) }
            : {}),
          ...(data.fromAddress !== undefined ? { fromAddress: data.fromAddress } : {}),
          ...(data.toAddresses !== undefined ? { toAddresses: data.toAddresses } : {}),
        },
      }),
    list: () =>
      prisma.notificationChannel.findMany({
        where: { organizationId },
        orderBy: { createdAt: "asc" },
      }),
    setEnabled: async (id, enabled) => {
      // updateMany, not update: it takes organizationId in the filter, so a channel belonging to
      // another organization is a miss rather than a cross-tenant write.
      const { count } = await prisma.notificationChannel.updateMany({
        where: { id, organizationId },
        data: { enabled },
      });
      if (count === 0) return null;
      return prisma.notificationChannel.findFirstOrThrow({ where: { id, organizationId } });
    },
    remove: async (id) => {
      const { count } = await prisma.notificationChannel.deleteMany({
        where: { id, organizationId },
      });
      return count > 0;
    },
  };
}

// EncryptionKey provisioning. The operational identity is KEK-wrapped and stored; the escrow
// identity is returned to the caller and DELIBERATELY NOT persisted — `encryptedIdentity` stays
// null, which is what makes it escrow. If it were stored, losing the metadata database would lose
// both keys at once and a self-backup could never be recovered.
export function createEncryptionKeyService(
  prisma: PrismaClient,
  kek: Buffer,
): Pick<EncryptionKeyRoutesDeps, "list" | "existing" | "provision" | "rotate"> {
  return {
    list: async (organizationId) =>
      (
        await scopedPrisma(prisma, organizationId).encryptionKey.findMany({
          orderBy: { createdAt: "asc" },
        })
      ).map((row) => ({
        keyId: row.keyId,
        type: row.type,
        state: row.state,
        publicRecipient: row.publicRecipient,
        // Derived, never a stored flag: the server can decrypt exactly when it holds an identity.
        serverCanDecrypt: row.encryptedIdentity !== null,
        createdAt: row.createdAt.toISOString(),
      })),

    existing: async (organizationId) =>
      (
        await scopedPrisma(prisma, organizationId).encryptionKey.findMany({
          select: { keyId: true, type: true, publicRecipient: true, state: true },
        })
      ).map((row) => ({
        keyId: row.keyId,
        type: row.type,
        publicRecipient: row.publicRecipient,
        state: row.state,
      })),

    provision: async (organizationId, escrow) => {
      const operational = await generateAgeKeyPair();
      // Generated even in "recipient" mode and then discarded with the function scope: the server
      // must never hold this identity, and the cleanest way to guarantee that is never to have it.
      const generatedEscrow = escrow.mode === "generate" ? await generateAgeKeyPair() : null;
      const escrowRecipient =
        generatedEscrow?.recipient ?? (escrow as { publicRecipient: string }).publicRecipient;
      const escrowKeyId = generatedEscrow?.keyId ?? recipientFingerprint(escrowRecipient);

      await prisma.$transaction([
        prisma.encryptionKey.create({
          data: {
            organizationId,
            keyId: operational.keyId,
            type: "operational",
            publicRecipient: operational.recipient,
            encryptedIdentity: encryptCredential(kek, operational.identity),
            state: "active",
          },
        }),
        prisma.encryptionKey.create({
          data: {
            organizationId,
            keyId: escrowKeyId,
            type: "escrow",
            publicRecipient: escrowRecipient,
            // No encryptedIdentity. Not an oversight — see the note above this function.
            state: "active",
          },
        }),
      ]);

      return {
        operationalKeyId: operational.keyId,
        escrowKeyId,
        escrowIdentity: generatedEscrow?.identity ?? null,
      };
    },

    rotate: async (organizationId, request) => {
      const db = scopedPrisma(prisma, organizationId);
      const outgoing = await db.encryptionKey.findFirst({
        where: { type: request.type, state: "active" },
      });
      // The route checked rotationBlockers first; this is the race, not the validation. Two
      // rotations of the same key at once must not both succeed and leave two active successors.
      if (outgoing === null) throw new Error(`no active ${request.type} key to rotate`);

      const generated =
        request.type === "operational" || request.escrow.mode === "generate"
          ? await generateAgeKeyPair()
          : null;
      const recipient =
        generated?.recipient ??
        (request as { escrow: { publicRecipient: string } }).escrow.publicRecipient;
      const keyId = generated?.keyId ?? recipientFingerprint(recipient);

      await prisma.$transaction([
        // The predecessor is RETIRED, never deleted, and `encryptedIdentity` is deliberately left
        // untouched. Clearing it here would make every artifact sealed to this key unopenable by
        // the server — turning a routine rotation into silent, unrecoverable data loss that would
        // only surface at the next restore.
        prisma.encryptionKey.updateMany({
          where: { organizationId, keyId: outgoing.keyId, state: "active" },
          data: { state: "retired", retiredAt: new Date() },
        }),
        prisma.encryptionKey.create({
          data: {
            organizationId,
            keyId,
            type: request.type,
            publicRecipient: recipient,
            // Same asymmetry as provisioning: the server holds an operational identity and never
            // an escrow one.
            ...(request.type === "operational" && generated !== null
              ? { encryptedIdentity: encryptCredential(kek, generated.identity) }
              : {}),
            state: "active",
          },
        }),
      ]);

      return {
        retiredKeyId: outgoing.keyId,
        newKeyId: keyId,
        // Only ever the escrow identity, and only when this server generated it. An operational
        // identity is never returned — the server keeps it and nobody needs to copy it down.
        escrowIdentity: request.type === "escrow" ? (generated?.identity ?? null) : null,
      };
    },
  };
}

// Members. The role has been enforced since the first migration and there was no way to grant one:
// bootstrap creates the FIRST admin, the setup token is consumed, and nothing else ever wrote a
// Membership. A product with three roles and one seat.
//
// `remove` deletes the MEMBERSHIP and never the User, and that is not tidiness — AuditLog.user is
// an optional relation with no onDelete, so Prisma's default is SetNull: deleting the row would
// silently strip the actor from every audit entry that person ever produced, including
// "restore.execute". Access is revoked either way, because betterAuthResolver returns null without
// a membership and every guarded route then answers 401.
//
// The cost of that choice, stated rather than discovered: User.email stays globally unique and
// taken, so a removed member cannot be re-added under the same address. Attaching a fresh
// membership to the surviving account would be the fix, and it is deliberately NOT done here while
// Better-Auth's sign-up endpoint is open — someone could register an address BEFORE an admin adds
// it and receive the membership meant for its real owner.
export function prismaMemberStore(
  prisma: PrismaClient,
  auth: Auth,
  organizationId: string,
): MemberStore {
  const toRecord = (row: {
    userId: string;
    role: string;
    createdAt: Date;
    user: { email: string; name: string; mustChangePassword: boolean };
  }): MemberRecord => ({
    userId: row.userId,
    email: row.user.email,
    name: row.user.name,
    role: row.role as Role,
    mustChangePassword: row.user.mustChangePassword,
    createdAt: row.createdAt,
  });

  return {
    list: async () =>
      (
        await prisma.membership.findMany({
          where: { organizationId },
          orderBy: { createdAt: "asc" },
          include: { user: { select: { email: true, name: true, mustChangePassword: true } } },
        })
      ).map(toRecord),

    create: async (data) => {
      // Checked first for a clean 409, and caught below as well: the unique constraint is the real
      // guard, and two admins adding the same address at once must not produce a 500.
      if ((await prisma.user.findUnique({ where: { email: data.email } })) !== null) return null;
      try {
        // Better-Auth hashes the password and creates the User + Account, exactly as the bootstrap
        // does for the first admin.
        await auth.api.signUpEmail({
          body: { email: data.email, password: data.password, name: data.name },
        });
      } catch {
        return null;
      }
      // The account can do nothing until this is cleared: requireRole refuses every role while it
      // stands. The temporary password is a shared secret until the member replaces it — the same
      // status docs/security.md gives the bootstrap password.
      const user = await prisma.user.update({
        where: { email: data.email },
        data: { mustChangePassword: true },
        select: { id: true, email: true, name: true, mustChangePassword: true },
      });
      const membership = await prisma.membership.create({
        data: { organizationId, userId: user.id, role: data.role },
        select: { userId: true, role: true, createdAt: true },
      });
      return toRecord({ ...membership, user });
    },

    updateRole: async (userId, role) => {
      // updateMany keeps organizationId in the filter, so a membership in another organization is
      // a miss rather than a cross-tenant write.
      const { count } = await prisma.membership.updateMany({
        where: { userId, organizationId },
        data: { role },
      });
      if (count === 0) return null;
      const row = await prisma.membership.findFirstOrThrow({
        where: { userId, organizationId },
        include: { user: { select: { email: true, name: true, mustChangePassword: true } } },
      });
      return toRecord(row);
    },

    remove: async (userId) => {
      const { count } = await prisma.membership.deleteMany({ where: { userId, organizationId } });
      return count > 0;
    },

    countAdmins: () => prisma.membership.count({ where: { organizationId, role: "admin" } }),

    roleOf: async (userId) => {
      const row = await prisma.membership.findFirst({
        where: { userId, organizationId },
        select: { role: true },
      });
      return row === null ? null : (row.role as Role);
    },
  };
}


// Answers "does this channel actually deliver?" the only way that means anything: by delivering.
//
// It goes through deliverToChannel — the SAME function the scheduled loop calls — on purpose. A
// test button with a path of its own could report a healthy channel while every real notification
// failed, which is precisely the shape of the bug this feature exists to catch (see
// notifications/secret-envelope.test.ts).
//
// The outcome is recorded on the row, and a success does NOT clear the failure: the two timestamps
// are kept side by side and the later one decides whether the channel reads VERIFIED or FAILED. A
// channel that recovered should still show that it once broke.
export async function testChannelDelivery(
  prisma: PrismaClient,
  deps: ChannelDeliveryDeps,
  now: () => Date,
  organizationId: string,
  id: string,
): Promise<TestDeliveryResult | null> {
  const channel = await prisma.notificationChannel.findFirst({ where: { id, organizationId } });
  if (channel === null) return null;

  const at = now();
  try {
    await deliverToChannel(deps, channel, TEST_NOTIFICATION);
    return {
      ok: true,
      channel: await prisma.notificationChannel.update({
        where: { id: channel.id },
        data: { lastSuccessAt: at },
      }),
    };
  } catch (err) {
    // Recorded rather than thrown: a channel that cannot deliver is an answer, not a server error,
    // and it is the answer the operator pressed the button for.
    const reason = err instanceof Error ? err.message : "test delivery failed";
    return {
      ok: false,
      channel: await prisma.notificationChannel.update({
        where: { id: channel.id },
        data: { lastFailureAt: at, lastFailure: reason },
      }),
    };
  }
}
