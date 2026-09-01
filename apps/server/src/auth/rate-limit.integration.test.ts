// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth, registerAuthHandler } from "./auth.js";

// Opt-in only: needs Docker. The counters live in Postgres now (see the RateLimit model), so a
// unit test with a fake client would only prove the option object was shaped correctly — not that
// an attempt past the limit is actually refused. That distinction is the whole point of the change.
const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";

describe.skipIf(!enabled)("login rate limit (integration)", () => {
  let container: StartedTestContainer;
  let prisma: PrismaClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "schrodump",
        POSTGRES_PASSWORD: "schrodump",
        POSTGRES_DB: "app",
      })
      .withExposedPorts(5432)
      // -h forces pg_isready onto TCP: the image's init phase runs a socket-only server first, and
      // waiting on the port alone connects during that window. Same lesson as claim.test.ts.
      .withHealthCheck({
        test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U schrodump -d app"],
        interval: 1000,
        timeout: 3000,
        retries: 30,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();
    const url = `postgresql://schrodump:schrodump@${container.getHost()}:${container.getMappedPort(5432)}/app?schema=public`;

    const schemaPath = fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url));
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", schemaPath], {
      env: { ...process.env, DATABASE_URL: url },
    });
    prisma = new PrismaClient({ datasourceUrl: url });

    app = Fastify();
    registerAuthHandler(
      app,
      createAuth(prisma, {
        secret: "test-secret-not-used-anywhere-real",
        baseURL: "http://localhost:8080",
        // 127.0.0.1/32 stands in for the UI's internal rewrite hop in the shipped image, so the
        // client address is resolved from X-Forwarded-For the way production does it.
        trustedProxies: ["127.0.0.1/32"],
      }),
    );
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (prisma !== undefined) await prisma.$disconnect();
    if (container !== undefined) await container.stop();
  });

  async function attempt(ip: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 127.0.0.1` },
      payload: { email: "nobody@example.com", password: "wrong-password" },
    });
  }

  it("refuses a sixth sign-in attempt from the same address inside the window", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await attempt("203.0.113.10")).statusCode);

    // The first five are rejected credentials (401), not rate limiting. If the limit were merely
    // absent every code here would be 401 and this test would fail on the last one.
    expect(codes.slice(0, 5).every((code) => code !== 429)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  // The bucket must key on the CLIENT address, not on the proxy hop. If trustedProxies were
  // ignored, every request would land in one bucket and this second address would already be
  // exhausted by the test above — which is exactly the deployment-wide outage the config prevents.
  it("keeps a different client address in its own bucket", async () => {
    expect((await attempt("203.0.113.99")).statusCode).not.toBe(429);
  });

  it("persists the counters in Postgres rather than process memory", async () => {
    // Memory storage would leave this table empty, and the limit would reset on every restart and
    // be per-replica instead of per-deployment.
    expect(await prisma.rateLimit.count()).toBeGreaterThan(0);
  });
});
