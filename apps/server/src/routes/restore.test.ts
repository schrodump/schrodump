// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { restoreRoutes } from "./restore.js";
import type { JobsService } from "./jobs.js";

function serviceWith(enqueueRestore = vi.fn(() => Promise.resolve("job-r"))): JobsService {
  return {
    listJobs: () => Promise.resolve({ items: [], total: 0 }),
    listArtifacts: () =>
    Promise.resolve({ items: [], total: 0, counts: { VERIFIED: 0, UNOBSERVED: 0, FAILED: 0 } }),
    enqueueBackup: () => Promise.resolve("b"),
    enqueueVerify: () => Promise.resolve("v"),
    enqueueRestore,
    testConnection: () => Promise.resolve({ ok: true, serverVersionNum: 1, failure: null, driverCode: null }),
  };
}

async function appWith(role: Role | null, service: JobsService) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u1", organizationId: "o1", role , mustChangePassword: false };
  await app.register((instance) => {
    restoreRoutes(() => Promise.resolve(ctx), service)(instance);
    return Promise.resolve();
  });
  return app;
}

describe("POST /artifacts/:id/restore", () => {
  it("enqueues a RESTORE job with the params and the caller's id (operator)", async () => {
    const enqueue = vi.fn(() => Promise.resolve("job-r"));
    const app = await appWith("operator", serviceWith(enqueue));
    const res = await app.inject({
      method: "POST",
      url: "/artifacts/a1/restore",
      payload: { target: "FULL_CLUSTER", confirmExistingDatabase: true },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ jobId: "job-r" });
    expect(enqueue).toHaveBeenCalledWith("o1", "a1", {
      target: "FULL_CLUSTER",
      confirmExistingDatabase: true,
      triggeredByUserId: "u1",
    });
    await app.close();
  });

  it("refuses a viewer (403)", async () => {
    const app = await appWith("viewer", serviceWith());
    const res = await app.inject({ method: "POST", url: "/artifacts/a1/restore", payload: { target: "FULL_CLUSTER" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("400 on an invalid target", async () => {
    const app = await appWith("operator", serviceWith());
    const res = await app.inject({ method: "POST", url: "/artifacts/a1/restore", payload: { target: "NOPE" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
