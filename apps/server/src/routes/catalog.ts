// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";

const RebuildSchema = z.object({ destinationId: z.string().min(1) });

export interface CatalogRebuildResultDTO {
  scanned: number;
  imported: string[];
  skipped: string[];
}

export interface CatalogRoutesDeps {
  resolver: SessionResolver;
  // Scans the destination's bucket and reimports missing artifacts (disaster recovery).
  rebuild(organizationId: string, destinationId: string): Promise<CatalogRebuildResultDTO>;
}

export function catalogRoutes(deps: CatalogRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.post(
      "/catalog/rebuild",
      { preHandler: [authenticate(deps.resolver), requireRole("admin")] },
      async (request, reply) => {
        const parsed = RebuildSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid rebuild request" });
        const result = await deps.rebuild(contextOf(request).organizationId, parsed.data.destinationId);
        return reply.send(result);
      },
    );
  };
}
