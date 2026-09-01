// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real, tenant-scoped route wiring. Not run in CI (needs a database, and canary/test-connection
// need S3 / a reachable target). Every store is built from scopedPrisma, so every query is
// automatically filtered by organizationId.

import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { definedOnly } from "../data/patch.js";
import { scopedPrisma } from "../data/scope.js";
import { decryptCredential, encryptCredential, parseEncryptedCredential } from "../crypto/envelope.js";
import {
  testTargetConnection,
  type EngineName,
  type TestConnectionResult,
} from "../probe/test-connection.js";
import type { DestinationStore } from "./destinations.js";
import type { ChannelStore } from "./notifications.js";
import type { PolicyRecord, PolicyStore } from "./policies.js";
import { generateAgeKeyPair, recipientFingerprint } from "../crypto/artifact.js";
import type { EncryptionKeyRoutesDeps } from "./encryption-keys.js";
import { LIST_PAGE_SIZE } from "./jobs.js";
import type { ArtifactRecord, JobsService } from "./jobs.js";

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
  organizationId: string,
  targetId: string,
): Promise<TestConnectionResult> {
  const row = await scopedPrisma(prisma, organizationId).databaseTarget.findFirst({
    where: { id: targetId },
  });
  if (row === null)
    return { ok: false, serverVersionNum: null, failure: "UNKNOWN", driverCode: null };

  const scope = ScopeSchema.safeParse(row.scope);
  return testTargetConnection({
    engine: row.engine as EngineName,
    host: row.host,
    port: row.port,
    username: row.username,
    password: decryptCredential(kek, parseEncryptedCredential(row.encryptedCredential)),
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
  bucketKey: string;
  manifestKey: string;
  engine: string;
  executionMode: string;
  serverVersionNum: number;
  sizeRawBytes: bigint;
  sizeCompressedBytes: bigint;
  checksumAlgorithm: string;
  checksum: string;
  compression: string;
  keyIds: string[];
  dependsOn: string[];
  createdAt: Date;
}): ArtifactRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    destinationId: row.destinationId,
    state: row.state,
    bucketKey: row.bucketKey,
    manifestKey: row.manifestKey,
    engine: row.engine,
    // Anything the DB does not spell STAGED is treated as STREAM — the same default the column
    // carries. A widened mode would have to opt into the gate explicitly, not inherit a pass.
    executionMode: row.executionMode === "STAGED" ? "STAGED" : "STREAM",
    serverVersionNum: row.serverVersionNum,
    sizeRawBytes: Number(row.sizeRawBytes),
    sizeCompressedBytes: Number(row.sizeCompressedBytes),
    checksumAlgorithm: row.checksumAlgorithm,
    checksum: row.checksum,
    compression: row.compression,
    keyIds: row.keyIds,
    dependsOn: row.dependsOn,
    createdAt: row.createdAt,
  };
}

// A single JobsService bound to the raw prisma; each method scopes by the passed organizationId.
export function createJobsService(prisma: PrismaClient, kek: Buffer): JobsService {
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
    listJobs: async (organizationId) => {
      const db = scopedPrisma(prisma, organizationId);
      const [items, total] = await Promise.all([
        db.backupJob.findMany({ orderBy: { createdAt: "desc" }, take: LIST_PAGE_SIZE }),
        db.backupJob.count(),
      ]);
      return { items, total };
    },
    // The counts come from a groupBy over the WHOLE table, never from `items`. A dashboard that
    // counted the returned page would report "3 unobserved backups" on a deployment with four
    // hundred of them the moment the list got capped — and the unobserved count is the number this
    // entire product leads with. Truncating the list is a rendering decision; truncating that
    // number would be a lie.
    listArtifacts: async (organizationId) => {
      const db = scopedPrisma(prisma, organizationId);
      const [rows, total, grouped] = await Promise.all([
        db.artifact.findMany({ orderBy: { createdAt: "desc" }, take: LIST_PAGE_SIZE }),
        db.artifact.count(),
        db.artifact.groupBy({ by: ["state"], _count: { _all: true } }),
      ]);
      const counts = { VERIFIED: 0, UNOBSERVED: 0, FAILED: 0 };
      for (const group of grouped) counts[group.state] = group._count._all;
      return { items: rows.map(toArtifactRecord), total, counts };
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
      probeTarget(prisma, kek, organizationId, targetId),
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
