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
