// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { jobsRoutes, type JobsService } from "./jobs.js";

const service: JobsService = {
  listJobs: () => Promise.resolve([{ id: "j1" }]),
  listArtifacts: () => Promise.resolve([{ id: "a1" }]),
  enqueueBackup: () => Promise.resolve("job-b"),
  enqueueVerify: () => Promise.resolve("job-v"),
  testConnection: () => Promise.resolve({ ok: true, serverVersionNum: 160002, failure: null, driverCode: null }),
};

async function appWith(role: Role | null) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role };
  await app.register((instance) => {
    jobsRoutes({ resolver: () => Promise.resolve(ctx), service })(instance);
    return Promise.resolve();
  });
  return app;
}

describe("jobs routes", () => {
  it("lets a viewer list jobs and artifacts", async () => {
    const app = await appWith("viewer");
    expect((await app.inject({ method: "GET", url: "/jobs" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/artifacts" })).statusCode).toBe(200);
    await app.close();
  });

  it("refuses a manual backup trigger from a viewer (403)", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "POST", url: "/policies/p1/backup" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("lets an operator trigger a manual backup (202)", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/policies/p1/backup" });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ jobId: "job-b" });
    await app.close();
  });
});
