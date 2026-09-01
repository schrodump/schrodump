// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Liveness that actually asks the question.
//
// This endpoint used to return a hardcoded `{ status: "ok" }`. The Dockerfile HEALTHCHECK polls it
// every 30s, so a deployment whose metadata database had gone away reported HEALTHY while every
// job failed — the process was up, and being up was all the old endpoint ever checked. That is the
// same reasoning this product rejects everywhere else: a thing that did not complain has not
// proven anything. So it asks the database.
//
// It reports; it does not act. Docker's `restart` policy reacts to a container EXITING, not to its
// health status, so an unhealthy container keeps running and the state becomes visible in
// `docker ps` and to whatever watches it. That is deliberately the behaviour we want: killing the
// process because PostgreSQL blipped would abort an in-flight backup — hours of work and a
// cleartext scratch directory — to fix a condition that is usually seconds long and not ours.

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { driverCodeOf } from "../probe/test-connection.js";

// Below the Dockerfile HEALTHCHECK's own 5s timeout, so a wedged database is reported by us — with
// a reason — rather than by wget giving up with none.
export const HEALTH_TIMEOUT_MS = 2000;

export type HealthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "timeout" | "unreachable"; readonly driverCode: string | null };

// Pure over its dependencies: the query and the clock come in, the verdict comes out. Keeping the
// PrismaClient out of here is what makes "the database hangs forever" a test rather than a story.
export async function probeDatabase(
  ping: () => Promise<unknown>,
  timeoutMs: number,
): Promise<HealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HealthResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout", driverCode: null }), timeoutMs);
  });

  // The rejection is converted here rather than thrown: a database that refuses a connection is an
  // expected answer to this question, not an exception to it.
  const query = ping().then(
    (): HealthResult => ({ ok: true }),
    (error: unknown): HealthResult => ({
      ok: false,
      reason: "unreachable",
      // Class and code only, never the message. A Prisma connection error spells out host and port
      // in its prose, and this endpoint is unauthenticated.
      driverCode: driverCodeOf(error),
    }),
  );

  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function registerHealth(
  app: FastifyInstance,
  prisma: PrismaClient,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): void {
  app.get("/health", async (request, reply) => {
    const result = await probeDatabase(() => prisma.$queryRaw`SELECT 1`, timeoutMs);
    if (result.ok) return { status: "ok" };

    // Logged as a code, never as the driver's prose — the same rule probe/test-connection.ts
    // follows, for the same reason.
    request.log.error(
      { check: "database", reason: result.reason, driverCode: result.driverCode },
      "health check failed",
    );
    // The body says which dependency, not where it lives or why it refused. /health is reachable
    // without a session.
    return reply.status(503).send({ status: "degraded", check: "database" });
  });
}
