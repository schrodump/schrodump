// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { authenticate, contextOf, type SessionResolver } from "../auth/rbac.js";

// GET /me exposes the caller's resolved context — crucially the RBAC role, which lives on the
// Membership and is not part of the Better-Auth session. The UI reads it to decide what to show
// (e.g. the restore button); the server still enforces every role check independently.
export function sessionRoutes(resolver: SessionResolver) {
  return (app: FastifyInstance): void => {
    app.get("/me", { preHandler: [authenticate(resolver)] }, (request, reply) =>
      reply.send(contextOf(request)),
    );
  };
}
