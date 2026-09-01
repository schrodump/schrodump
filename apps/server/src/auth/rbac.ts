// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyReply, FastifyRequest } from "fastify";

export type Role = "admin" | "operator" | "viewer";

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function hasAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

// viewer never triggers a restore — this is an audit requirement, not a convenience.
export function canTriggerRestore(role: Role): boolean {
  return hasAtLeast(role, "operator");
}

export interface AuthContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: Role;
  // Set for the bootstrap admin, whose password arrives through SCHRODUMP_ADMIN_PASSWORD — readable
  // in `docker inspect` and sitting in .env on disk. Until it is rotated the account is a shared
  // secret, so the session authenticates but is not allowed to act. Enforced in requireRole below.
  readonly mustChangePassword: boolean;
}

// Resolves the caller's authenticated context from the request (real impl uses Better-Auth;
// tests inject a fake). Returns null when there is no valid session/membership.
export type SessionResolver = (request: FastifyRequest) => Promise<AuthContext | null>;

declare module "fastify" {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

// preHandler: populates request.authContext or replies 401.
export function authenticate(resolver: SessionResolver) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const ctx = await resolver(request);
    if (ctx === null) {
      return reply.status(401).send({ error: "unauthenticated" });
    }
    request.authContext = ctx;
    return undefined;
  };
}

// Reads the authenticated context inside a handler (authenticate() guarantees it is present).
export function contextOf(request: FastifyRequest): AuthContext {
  const ctx = request.authContext;
  if (ctx === undefined) {
    throw new Error("missing auth context — authenticate() must run before the handler");
  }
  return ctx;
}

// preHandler: enforces a minimum role. Must run after authenticate().
export function requireRole(min: Role) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const ctx = request.authContext;
    if (ctx === undefined) {
      return reply.status(401).send({ error: "unauthenticated" });
    }
    // Checked BEFORE the role, and applying to every role including viewer. The point is not what
    // this account is allowed to do — it is that the password authorising it is still the one from
    // the environment, which anyone with `docker inspect` can read. Rotating it is the only way
    // out; Better-Auth's own change-password endpoint lives under /api/auth/* and does not pass
    // through this gate, and GET /me uses authenticate() alone so the UI can see WHY it is blocked.
    if (ctx.mustChangePassword) {
      return reply.status(403).send({ error: "password_rotation_required" });
    }
    if (!hasAtLeast(ctx.role, min)) {
      return reply.status(403).send({ error: "forbidden" });
    }
    return undefined;
  };
}
