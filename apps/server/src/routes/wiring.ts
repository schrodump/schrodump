// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real, tenant-scoped route wiring. Not run in CI (needs a database, and canary/test-connection
// need S3 / a reachable target). Every store is built from scopedPrisma, so every query is
// automatically filtered by organizationId.

import type { PrismaClient } from "@prisma/client";
import { scopedPrisma } from "../data/scope.js";
import type { DestinationStore } from "./destinations.js";
import type { PolicyRecord, PolicyStore } from "./policies.js";
import type { JobsService } from "./jobs.js";

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

// A single JobsService bound to the raw prisma; each method scopes by the passed organizationId.
export function createJobsService(prisma: PrismaClient): JobsService {
  const enqueue = async (organizationId: string, kind: "BACKUP" | "VERIFY", correlationId: string): Promise<string> => {
    const db = scopedPrisma(prisma, organizationId);
    const job = await db.backupJob.create({
      data: { organizationId, kind, state: "PENDING", correlationId },
      select: { id: true },
    });
    return job.id;
  };
  return {
    listJobs: (organizationId) =>
      scopedPrisma(prisma, organizationId).backupJob.findMany({ orderBy: { createdAt: "desc" } }),
    listArtifacts: (organizationId) =>
      scopedPrisma(prisma, organizationId).artifact.findMany({ orderBy: { createdAt: "desc" } }),
    // Real dispatch (probe / descriptor / runner composition) is handled by the worker that picks
    // up the PENDING job; here we only enqueue it.
    enqueueBackup: (organizationId, policyId) => enqueue(organizationId, "BACKUP", `backup:${policyId}`),
    enqueueVerify: (organizationId, artifactId) => enqueue(organizationId, "VERIFY", `verify:${artifactId}`),
    // test-connection is composed with the engines probe by the caller; kept minimal here.
    testConnection: () => Promise.resolve({ ok: false, serverVersionNum: null }),
  };
}
