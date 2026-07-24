// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real, tenant-scoped route wiring. Not run in CI (needs a database, and canary/test-connection
// need S3 / a reachable target). Every store is built from scopedPrisma, so every query is
// automatically filtered by organizationId.

import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { scopedPrisma } from "../data/scope.js";
import { decryptCredential, parseEncryptedCredential } from "../crypto/envelope.js";
import { testTargetConnection, type EngineName, type TestConnectionResult } from "../probe/test-connection.js";
import type { DestinationStore } from "./destinations.js";
import type { PolicyRecord, PolicyStore } from "./policies.js";
import type { ArtifactRecord, JobsService } from "./jobs.js";

export function prismaDestinationStore(prisma: PrismaClient, organizationId: string): DestinationStore {
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
  if (row === null) return { ok: false, serverVersionNum: null, failure: "UNKNOWN", driverCode: null };

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
    listJobs: (organizationId) =>
      scopedPrisma(prisma, organizationId).backupJob.findMany({ orderBy: { createdAt: "desc" } }),
    listArtifacts: async (organizationId) =>
      (await scopedPrisma(prisma, organizationId).artifact.findMany({ orderBy: { createdAt: "desc" } })).map(
        toArtifactRecord,
      ),
    // Real dispatch (probe / descriptor / runner composition) is handled by the worker that picks
    // up the PENDING job; here we only enqueue it.
    enqueueBackup: (organizationId, policyId) => enqueue(organizationId, "BACKUP", { policyId }),
    enqueueVerify: (organizationId, artifactId) => enqueue(organizationId, "VERIFY", { artifactId }),
    testConnection: (organizationId, targetId) => probeTarget(prisma, kek, organizationId, targetId),
  };
}
