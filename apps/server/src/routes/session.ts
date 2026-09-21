// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { authenticate, contextOf, type SessionResolver } from "../auth/rbac.js";

export interface SessionRoutesDeps {
  // SCHRODUMP_TZ, the zone every cron is read in.
  timeZone: string;
}

// GET /me exposes the caller's resolved context — crucially the RBAC role, which lives on the
// Membership and is not part of the Better-Auth session. The UI reads it to decide what to show
// (e.g. the restore button); the server still enforces every role check independently.
//
// It also carries the instance's `timeZone`, because this is the one response every signed-in
// screen already has, whatever the role. The policy form needs it before any policy exists — its
// preview reads the expression being typed on the scheduler's clock — so it cannot ride on the
// items of GET /policies, and GET /instance is admin-only. Adding a field to this object breaks no
// client; turning the bare array GET /policies returns into an envelope would have broken them all.
export function sessionRoutes(resolver: SessionResolver, deps: SessionRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.get("/me", { preHandler: [authenticate(resolver)] }, (request, reply) =>
      reply.send({ ...contextOf(request), timeZone: deps.timeZone }),
    );
  };
}
