// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { authenticate, requireRole, type SessionResolver } from "../auth/rbac.js";

// Self-backups are INSTANCE-scoped, not organization-scoped: one metadata database per deployment.
// Hence admin-only and deliberately not filtered by the caller's organization — there is nothing
// here to leak between tenants (no target, no credential, no data), and an admin who cannot see
// whether the deployment is backing itself up cannot act on it.
export const SELF_BACKUP_PAGE_SIZE = 20;

export interface SelfBackupDTO {
  id: string;
  state: "RUNNING" | "SUCCEEDED" | "FAILED";
  destinationId: string;
  bucketKey: string | null;
  sizeBytes: number | null;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SelfBackupRoutesDeps {
  resolver: SessionResolver;
  prisma: PrismaClient;
  // Null when SCHRODUMP_SELF_BACKUP_DESTINATION_ID is unset. Reported explicitly so the UI can say
  // "not configured" rather than showing an empty list, which reads identically to "configured and
  // never ran" — the exact ambiguity this product exists to remove.
  configuredDestinationId: string | null;
}

export function selfBackupRoutes(deps: SelfBackupRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.get(
      "/self-backups",
      { preHandler: [authenticate(deps.resolver), requireRole("admin")] },
      async (_request, reply) => {
        const rows = await deps.prisma.selfBackup.findMany({
          orderBy: { startedAt: "desc" },
          take: SELF_BACKUP_PAGE_SIZE,
        });
        const items: SelfBackupDTO[] = rows.map((row) => ({
          id: row.id,
          state: row.state,
          destinationId: row.destinationId,
          bucketKey: row.bucketKey,
          // BigInt does not survive JSON.stringify; a metadata dump is never near 2^53 bytes.
          sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
          reason: row.reason,
          startedAt: row.startedAt.toISOString(),
          finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
        }));
        return reply.send({ configured: deps.configuredDestinationId !== null, items });
      },
    );
  };
}
