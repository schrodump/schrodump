// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext, Role, SessionResolver } from "./rbac.js";

export function createAuth(prisma: PrismaClient, opts: { secret: string; baseURL: string }) {
  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: { enabled: true },
    secret: opts.secret,
    baseURL: opts.baseURL,
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
