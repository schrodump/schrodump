// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { HEALTH_TIMEOUT_MS, probeDatabase, registerHealth } from "./health.js";

function appWith(queryRaw: () => Promise<unknown>, timeoutMs = 50) {
  const app = Fastify();
  registerHealth(app, { $queryRaw: queryRaw } as unknown as PrismaClient, timeoutMs);
  return app;
}

describe("probeDatabase", () => {
  it("is ok when the query answers", async () => {
    await expect(probeDatabase(() => Promise.resolve([{ "?column?": 1 }]), 1000)).resolves.toEqual({
      ok: true,
    });
  });

  it("reports unreachable with the driver code, never the message", async () => {
    const error = Object.assign(new Error("Can't reach database server at db:5432 as user schrodump"), {
      code: "P1001",
    });

    const result = await probeDatabase(() => Promise.reject(error), 1000);

    expect(result).toEqual({ ok: false, reason: "unreachable", driverCode: "ERROR/P1001" });
    // The host, the port and the user all appear in that driver message. None of them may travel.
    expect(JSON.stringify(result)).not.toContain("db:5432");
    expect(JSON.stringify(result)).not.toContain("schrodump");
  });

  it("reports timeout when the database never answers at all", async () => {
    // The failure mode a plain try/catch cannot see: not refused, just never answered.
    const result = await probeDatabase(() => new Promise(() => {}), 20);

    expect(result).toEqual({ ok: false, reason: "timeout", driverCode: null });
  });

  it("does not let a late answer overwrite the timeout verdict", async () => {
    const result = await probeDatabase(
      () => new Promise((resolve) => setTimeout(() => resolve([1]), 60)),
      10,
    );

    expect(result.ok).toBe(false);
  });
});

describe("GET /health", () => {
  it("answers 200 when the database answers", async () => {
    const app = appWith(() => Promise.resolve([{ "?column?": 1 }]));

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("answers 503 when the database is unreachable", async () => {
    // The whole point of the change: the process is up, and being up is no longer the answer.
    const app = appWith(() => Promise.reject(new Error("connection refused")));

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", check: "database" });
  });

  it("answers 503 when the database hangs past the timeout", async () => {
    const app = appWith(() => new Promise(() => {}), 20);

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(503);
  });

  it("leaks nothing about the database into the unauthenticated body", async () => {
    const error = Object.assign(new Error("Can't reach database server at 10.0.0.5:5432"), {
      code: "P1001",
    });
    const app = appWith(() => Promise.reject(error));

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.body).not.toContain("10.0.0.5");
    expect(res.body).not.toContain("P1001");
  });

  it("logs the failure as a code rather than the driver's prose", async () => {
    const error = Object.assign(new Error("Can't reach database server at 10.0.0.5:5432"), {
      code: "P1001",
    });
    const app = Fastify();
    const log = vi.fn();
    registerHealth(app, { $queryRaw: () => Promise.reject(error) } as unknown as PrismaClient, 50);
    app.addHook("onRequest", (request, _reply, done) => {
      request.log.error = log as unknown as typeof request.log.error;
      done();
    });

    await app.inject({ method: "GET", url: "/health" });

    expect(log).toHaveBeenCalledWith(
      { check: "database", reason: "unreachable", driverCode: "ERROR/P1001" },
      "health check failed",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("10.0.0.5");
  });

  it("keeps the probe budget under the Dockerfile HEALTHCHECK timeout", () => {
    // The HEALTHCHECK gives wget 5s. If our own budget were larger, a wedged database would be
    // reported by wget with no reason instead of by us with one.
    expect(HEALTH_TIMEOUT_MS).toBeLessThan(5000);
  });
});
