// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext, Role, SessionResolver } from "./rbac.js";

// Comma-separated CIDRs (or bare addresses) naming every hop that sits in FRONT of this server.
// Empty list means "nothing is trusted", which is the correct default and not a placeholder.
//
// This is the setting that decides whether the login rate limit is a control or theatre, and it
// fails in both directions if it is wrong:
//
//   - Too permissive, or absent with a single-hop X-Forwarded-For: the header is attacker-supplied.
//     Rotating it on every request gives every attempt its own bucket and the limit never fires.
//   - Absent behind a real proxy: X-Forwarded-For arrives with more than one entry, Better-Auth
//     refuses to guess which is the client, and every request in the deployment shares ONE bucket.
//     Three sign-ins per ten seconds across all users — an outage wearing a security feature.
//
// So it is explicit, and the server says at boot when it is empty.
export function parseTrustedProxies(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export interface AuthOptions {
  secret: string;
  baseURL: string;
  // See parseTrustedProxies. Empty is honest, not broken.
  trustedProxies: string[];
}

export function createAuth(prisma: PrismaClient, opts: AuthOptions) {
  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: { enabled: true },
    secret: opts.secret,
    baseURL: opts.baseURL,
    rateLimit: {
      // Explicit rather than inherited. Better-Auth enables this only when NODE_ENV is production,
      // which makes the security posture depend on a variable set for unrelated reasons.
      enabled: true,
      // Database, not memory: the counters must be shared across replicas and survive a restart.
      // See the RateLimit model for why the default is wrong for this deployment shape.
      storage: "database",
      window: 10,
      max: 100,
      customRules: {
        // Tighter than the library's built-in 3-per-10s on /sign-in. Password guessing is a slow
        // grind, so the window that matters is minutes, not seconds: 5 attempts per five minutes
        // per address costs a legitimate operator who fat-fingers a password nothing, and costs an
        // attacker three orders of magnitude.
        "/sign-in/email": { window: 300, max: 5 },
        "/sign-up/email": { window: 300, max: 5 },
      },
    },
    advanced: {
      ipAddress: {
        trustedProxies: opts.trustedProxies,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

// Resolves the request's session and the user's role in their organization. RBAC role comes from
// Membership, never from the auth model.
export function betterAuthResolver(auth: Auth, prisma: PrismaClient): SessionResolver {
  return async (request) => {
    const result = await auth.api.getSession({ headers: toHeaders(request.headers) });
    if (result === null) return null;
    const membership = await prisma.membership.findFirst({ where: { userId: result.user.id } });
    if (membership === null) return null;
    const ctx: AuthContext = {
      userId: result.user.id,
      organizationId: membership.organizationId,
      role: membership.role as Role,
    };
    return ctx;
  };
}

// Mounts the Better-Auth request handler at /api/auth/*.
export function registerAuthHandler(app: FastifyInstance, auth: Auth): void {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, `${request.protocol}://${request.host}`);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const init: RequestInit = {
        method: request.method,
        headers: toHeaders(request.headers),
      };
      if (hasBody) {
        init.body = JSON.stringify(request.body ?? {});
      }
      const response = await auth.handler(new Request(url, init));
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      const body = await response.text();
      return reply.send(body.length > 0 ? body : null);
    },
  });
}
