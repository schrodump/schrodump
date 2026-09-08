// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";
import { scopedPrisma } from "../data/scope.js";
import { LIST_PAGE_SIZE } from "./jobs.js";

// One row of the trail the server has recorded since the first migration but never let anyone read.
// It answers "who did what, when" — a restore, a target/destination/policy change, an artifact
// deletion, and the credential reads a job makes. `actorEmail` is null for the latter: job execution
// has no user, and the row is attributed through correlationId instead — collapsing that null to a
// name would claim a person ran something a scheduler did. `metadata` is deliberately NOT exposed:
// it carries per-action detail that is not needed to answer the who/what/when the trail is for, and
// a compliance list is the wrong place to widen the surface.
export interface AuditRecord {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  correlationId: string;
  actorEmail: string | null;
  createdAt: Date;
}

export interface AuditListDTO {
  items: AuditRecord[];
  total: number;
}

export interface AuditStore {
  list(): Promise<AuditListDTO>;
}

export function prismaAuditStore(prisma: PrismaClient, organizationId: string): AuditStore {
  const db = scopedPrisma(prisma, organizationId);
  return {
    list: async () => {
      const [rows, total] = await Promise.all([
        db.auditLog.findMany({
          orderBy: { createdAt: "desc" },
          take: LIST_PAGE_SIZE,
          include: { user: { select: { email: true } } },
        }),
        db.auditLog.count(),
      ]);
      return {
        items: rows.map((row) => ({
          id: row.id,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          correlationId: row.correlationId,
          actorEmail: row.user?.email ?? null,
          createdAt: row.createdAt,
        })),
        total,
      };
    },
  };
}

export interface AuditRoutesDeps {
  resolver: SessionResolver;
  store(organizationId: string): AuditStore;
}

export function auditRoutes(deps: AuditRoutesDeps) {
  return (app: FastifyInstance): void => {
    // admin-only: the trail is the record of who holds power over this deployment's data, and it is
    // the compliance artifact an auditor reads. Reading it is itself a privileged act.
    app.get(
      "/audit-log",
      { preHandler: [authenticate(deps.resolver), requireRole("admin")] },
      async (request, reply) => reply.send(await deps.store(contextOf(request).organizationId).list()),
    );
  };
}
