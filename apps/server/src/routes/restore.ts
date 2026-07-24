// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";
import type { JobsService } from "./jobs.js";

const ParamsSchema = z.object({ id: z.string().min(1) });
const BodySchema = z.object({
  target: z.enum(["FULL_CLUSTER", "DATABASE", "SCHEMA", "TABLE", "COLLECTION"]),
  confirmExistingDatabase: z.boolean().default(false),
});

// Restore is guarded operator+ (a viewer is refused — audit requirement). It enqueues a RESTORE
// job; the worker runs the real download -> decrypt -> restore pipeline.
export function restoreRoutes(resolver: SessionResolver, service: JobsService) {
  return (app: FastifyInstance): void => {
    app.post(
      "/artifacts/:id/restore",
      { preHandler: [authenticate(resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = ParamsSchema.safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const body = BodySchema.safeParse(request.body ?? {});
        if (!body.success) return reply.status(400).send({ error: "invalid request" });
        const ctx = contextOf(request);
        const jobId = await service.enqueueRestore(ctx.organizationId, params.data.id, {
          target: body.data.target,
          confirmExistingDatabase: body.data.confirmExistingDatabase,
          triggeredByUserId: ctx.userId,
        });
        return reply.status(202).send({ jobId });
      },
    );
  };
}
