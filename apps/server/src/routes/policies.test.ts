// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { policyRoutes, type PolicyRecord, type PolicyStore } from "./policies.js";

const RECORD: PolicyRecord = {
  id: "p1",
  name: "nightly",
  targetId: "t1",
  destinationId: "d1",
  cron: "0 3 * * *",
  keepLast: 7,
  keepDaily: 0,
  keepWeekly: 4,
  keepMonthly: 6,
  keepYearly: 1,
  minAgeBeforeDeleteMs: 0,
  verifyLevel: "CHECKSUM",
  executionMode: "STREAM",
  parallelism: 1,
  compression: "zstd",
  enabled: true,
};

const STORE: PolicyStore = {
  create: () => Promise.resolve(RECORD),
  list: () => Promise.resolve([RECORD]),
  get: () => Promise.resolve(RECORD),
  update: () => Promise.resolve(RECORD),
  remove: () => Promise.resolve({ ok: true }),
};

async function appWith(role: Role | null, over: Partial<PolicyStore> = {}) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role };
  await app.register((instance) => {
    policyRoutes({
      resolver: () => Promise.resolve(ctx),
      store: () => ({ ...STORE, ...over }),
    })(instance);
    return Promise.resolve();
  });
  return app;
}

describe("PATCH /policies/:id", () => {
  // The everyday reasons this route has to exist: a cron typed wrong, a retention window that
  // turned out to be too short, and — the one with no workaround at all before this — stopping a
  // policy without destroying the history that proves what it did.
  it("edits the schedule, the retention counters and the enabled flag", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = await appWith("operator", {
      update: (_id, data) => {
        seen.push(data as unknown as Record<string, unknown>);
        return Promise.resolve(RECORD);
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/policies/p1",
      payload: { cron: "0 4 * * *", keepLast: 14, enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(seen[0]).toEqual({ cron: "0 4 * * *", keepLast: 14, enabled: false });
    await app.close();
  });

  // Retention reasons per policy: it prunes the artifacts produced by THIS policy's backups, on
  // THIS policy's destination. Repointing either would mix two different databases' artifacts into
  // one GFS chain, and strand every artifact on the old destination outside retention forever —
  // never pruned, never attributable. That is a new policy, not an edit.
  it.each(["targetId", "destinationId"] as const)(
    "refuses to repoint %s, which would strand the artifacts already taken under it",
    async (field) => {
      const app = await appWith("operator");
      const res = await app.inject({
        method: "PATCH",
        url: "/policies/p1",
        payload: { [field]: "other" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    },
  );

  it("rejects an empty patch", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "PATCH", url: "/policies/p1", payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an id outside the caller's organization", async () => {
    const app = await appWith("operator", { update: () => Promise.resolve(null) });
    const res = await app.inject({ method: "PATCH", url: "/policies/nope", payload: { keepLast: 3 } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a policy edit for a viewer (operator+ only)", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "PATCH", url: "/policies/p1", payload: { keepLast: 3 } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("DELETE /policies/:id", () => {
  it("deletes a policy that never ran", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "DELETE", url: "/policies/p1" });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  // BackupJob.policy is an OPTIONAL relation, so Prisma's default on delete is SetNull, not
  // Restrict — the database would happily accept this and silently blank policyId on every job the
  // policy ever ran. The artifacts those jobs produced would lose their only link back to a
  // policy: unattributable in the catalogue, and permanently invisible to retention, which selects
  // by policyId. Nothing would look broken. It has to be refused explicitly.
  it("refuses with 409 once the policy has run, and names the alternative", async () => {
    const app = await appWith("operator", {
      remove: () =>
        Promise.resolve({
          ok: false,
          reason: "9 jobs still reference this policy — disable it instead of deleting it",
        }),
    });
    const res = await app.inject({ method: "DELETE", url: "/policies/p1" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining("disable it") });
    await app.close();
  });

  it("refuses a policy delete for a viewer (operator+ only)", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "DELETE", url: "/policies/p1" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
