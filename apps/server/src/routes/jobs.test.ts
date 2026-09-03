// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { jobsRoutes, LIST_PAGE_SIZE, type JobsService } from "./jobs.js";

const service: JobsService = {
  listJobs: () => Promise.resolve({ items: [{ id: "j1" }], total: 1 }),
  listArtifacts: () =>
    Promise.resolve({ counts: { VERIFIED: 0, UNOBSERVED: 1, FAILED: 0 }, total: 1, items: [
      {
        id: "a1",
        jobId: "j1",
        destinationId: "d1",
        state: "UNOBSERVED",
        bucketKey: "org/backup.age",
        manifestKey: "org/backup.manifest.json",
        engine: "postgres",
        executionMode: "STREAM",
        sourceHasOplog: null,
        dumpIsMultiDatabase: null,
        serverVersionNum: 160002,
        sizeRawBytes: 9_000_000_000,
        sizeCompressedBytes: 1_500_000_000,
        checksumAlgorithm: "sha256",
        checksum: "abc",
        compression: "zstd",
        keyIds: ["age1..."],
        dependsOn: [],
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ] }),
  enqueueBackup: () => Promise.resolve("job-b"),
  enqueueVerify: () => Promise.resolve("job-v"),
  enqueueRestore: () => Promise.resolve("job-r"),
  testConnection: () => Promise.resolve({ ok: true, serverVersionNum: 160002, failure: null, driverCode: null }),
  recordProbe: () => Promise.resolve(),
};

async function appWith(role: Role | null, over: Partial<JobsService> = {}) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role , mustChangePassword: false };
  await app.register((instance) => {
    jobsRoutes({ resolver: () => Promise.resolve(ctx), service: { ...service, ...over } })(instance);
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

describe("list bounds", () => {
  it("caps both lists at a page size small enough to render", () => {
    // A deployment running twenty policies daily, each chaining a verify, writes ~40 job rows a day.
    // The cap is what keeps a three-year-old install's dashboard from fetching fifty thousand rows.
    expect(LIST_PAGE_SIZE).toBeLessThanOrEqual(500);
    expect(LIST_PAGE_SIZE).toBeGreaterThan(0);
  });

  it("sends the artifact counts and total alongside the page", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "GET", url: "/artifacts" });
    const body = JSON.parse(res.body) as {
      items: unknown[];
      total: number;
      counts: Record<string, number>;
    };
    // The counts must be their own field, not something the client can only get by counting items.
    // A truncated page would understate the unobserved total, which is the number the dashboard
    // leads with — the one figure this product must never round down.
    expect(body.counts).toEqual({ VERIFIED: 0, UNOBSERVED: 1, FAILED: 0 });
    expect(body.total).toBe(1);
    expect(Array.isArray(body.items)).toBe(true);
    await app.close();
  });
});

// Same gap as the destination canary: the probe answered one browser and the deployment kept no
// memory of it, so the setup checklist could never tick "test the connection" off. A target with
// credentials in a form and a target proven reachable are different things, and only one of them
// is a backup that will run tonight.
describe("test-connection — the probe outcome is recorded", () => {
  it("records a passing probe against the target that was probed", async () => {
    const recorded: unknown[] = [];
    const app = await appWith("operator", {
      recordProbe: (organizationId, targetId, result) => {
        recorded.push({ organizationId, targetId, ok: result.ok, failure: result.failure });
        return Promise.resolve();
      },
    });
    await app.inject({ method: "POST", url: "/targets/t1/test-connection" });
    expect(recorded).toEqual([{ organizationId: "o", targetId: "t1", ok: true, failure: null }]);
    await app.close();
  });

  it("records the failure CODE on a refusal, never the driver's prose", async () => {
    // The codes exist because driver errors embed the credential they failed with. A stored
    // message would put that credential in a column that the list endpoint then hands out.
    const recorded: unknown[] = [];
    const app = await appWith("operator", {
      testConnection: () =>
        Promise.resolve({
          ok: false,
          serverVersionNum: null,
          failure: "AUTH_FAILED",
          driverCode: "28P01",
        }),
      recordProbe: (organizationId, targetId, result) => {
        recorded.push({ ok: result.ok, failure: result.failure });
        return Promise.resolve();
      },
    });
    await app.inject({ method: "POST", url: "/targets/t1/test-connection" });
    expect(recorded).toEqual([{ ok: false, failure: "AUTH_FAILED" }]);
    await app.close();
  });

  it("still answers the caller with the probe result, unchanged", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/targets/t1/test-connection" });
    expect(res.json()).toEqual({
      ok: true,
      serverVersionNum: 160002,
      failure: null,
      driverCode: null,
    });
    await app.close();
  });
});
