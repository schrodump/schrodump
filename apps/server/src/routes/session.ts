// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { authenticate, contextOf, type SessionResolver } from "../auth/rbac.js";

export interface SessionRoutesDeps {
  // SCHRODUMP_TZ, the zone every cron is read in.
  timeZone: string;
  // Read at request time, like GET /instance reads its config.
  scratchConfigured(): boolean;
}

// GET /me exposes the caller's resolved context — crucially the RBAC role, which lives on the
// Membership and is not part of the Better-Auth session. The UI reads it to decide what to show
// (e.g. the restore button); the server still enforces every role check independently.
//
// It also carries two deployment facts every role's screens depend on, because this is the one
// response every signed-in screen already has and GET /instance is admin-only:
//
// - `timeZone`, the instance zone every cron is read in. The policy form needs it before any
//   policy exists — its preview reads the expression being typed on the scheduler's clock — so
//   it cannot ride on the items of GET /policies, whose bare array no client expects to change.
// - `scratchConfigured`. It lived only on GET /instance, so for an operator the policy form read
//   "no scratch" on a deployment that has one: it withheld STAGED, warned that a full-restore
//   verify could never run, defaulted new policies to the weaker CHECKSUM, and saved an edited
//   policy's parallelism as 1. A boolean, not the path: the path stays on the admin-only route.
export function sessionRoutes(resolver: SessionResolver, deps: SessionRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.get("/me", { preHandler: [authenticate(resolver)] }, (request, reply) =>
      reply.send({
        ...contextOf(request),
        timeZone: deps.timeZone,
        scratchConfigured: deps.scratchConfigured(),
      }),
    );
  };
}
