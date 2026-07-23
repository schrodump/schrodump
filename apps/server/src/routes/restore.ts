// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireRole, type SessionResolver } from "../auth/rbac.js";

const ParamsSchema = z.object({ id: z.string().min(1) });

// Restore is guarded at operator+; a viewer is refused (audit requirement). The actual restore
// execution lands in the next prompt (scheduler / job execution).
export function restoreRoutes(resolver: SessionResolver) {
  return (app: FastifyInstance): void => {
    app.post(
      "/artifacts/:id/restore",
      { preHandler: [authenticate(resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = ParamsSchema.parse(request.params);
        return reply.status(501).send({
          error: "restore execution not yet implemented",
          artifactId: params.id,
        });
      },
    );
  };
}
