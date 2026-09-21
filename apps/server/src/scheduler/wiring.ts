// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Prisma, type PrismaClient } from "@prisma/client";
import { currentWindow } from "./cron.js";
import type { CronEvaluator, SchedulerStore } from "./scheduler.js";

// Every window is computed on the instance's clock (SCHRODUMP_TZ), never the process's: the
// container runs UTC, and an expression read there is not the one the operator wrote.
export function cronEvaluator(timeZone: string): CronEvaluator {
  return {
    currentWindow: (cron, now) => currentWindow(cron, now, timeZone),
  };
}

// The scheduler is a SYSTEM process, not a tenant request: it legitimately reads policies across
// organizations and writes jobs carrying each policy's organizationId. This is the only place
// with cross-organization queries, and every write it performs is organization-scoped.
export function prismaSchedulerStore(prisma: PrismaClient): SchedulerStore {
  return {
    enabledPolicies: () =>
      prisma.backupPolicy.findMany({
        where: { enabled: true },
        select: { id: true, organizationId: true, cron: true },
      }),

    createScheduledJob: async (input) => {
      try {
        const job = await prisma.backupJob.create({
          data: {
            organizationId: input.organizationId,
            policyId: input.policyId,
            scheduledAt: input.scheduledAt,
            kind: "BACKUP",
            state: "PENDING",
            correlationId: input.correlationId,
          },
          select: { id: true },
        });
        return job.id;
      } catch (error) {
        // P2002 = unique violation on (policyId, scheduledAt): the window already has a job.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return null;
        }
        throw error;
      }
    },

    failRunningJobs: async (reason) => {
      const result = await prisma.backupJob.updateMany({
        where: { state: "RUNNING" },
        data: { state: "FAILED", reason, finishedAt: new Date() },
      });
      return result.count;
    },
  };
}
