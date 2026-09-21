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

const NOW = new Date("2026-09-21T12:00:00.000Z");

async function appWith(role: Role | null, over: Partial<PolicyStore> = {}, timeZone = "UTC") {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role , mustChangePassword: false };
  await app.register((instance) => {
    policyRoutes({
      resolver: () => Promise.resolve(ctx),
      store: () => ({ ...STORE, ...over }),
      timeZone,
      now: () => NOW,
    })(instance);
    return Promise.resolve();
  });
  return app;
}

const CREATE_BODY = { name: "nightly", targetId: "t1", destinationId: "d1", cron: "0 3 * * *" };

// SC-02, reproduced on a live deployment: the cron was `z.string().min(1)`, so "0 0 30 2 *" was
// stored with a 201 and from the next tick every scheduler pass threw. The route now reads it with
// the scheduler's own parser, and the refusal names the field — the contract since #142.
describe("a cron the scheduler cannot read is refused before it is stored", () => {
  const unreadable = [
    ["0 0 30 2 *", /day of month/i],
    ["0 0 31 4 *", /day of month/i],
    ["0 0 31 4,6,9,11 *", /never fire/],
    ["every day", /five fields/],
    ["every day of the week", /cannot read it: invalid characters/i],
    ["0 3 * * 8", /range/i],
    // A seconds field: cron-parser takes it, the interface's grammar does not, and it can name a
    // new window every second.
    ["0 0 2 * * *", /five fields/],
    ["*/10 * * * * *", /five fields/],
  ] as const;

  it.each(unreadable)("POST refuses %j, under `cron`", async (cron, why) => {
    const created: unknown[] = [];
    const app = await appWith("operator", {
      create: (data) => {
        created.push(data);
        return Promise.resolve(RECORD);
      },
    });
    const res = await app.inject({ method: "POST", url: "/policies", payload: { ...CREATE_BODY, cron } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; field?: string; detail?: string };
    expect(body.field).toBe("cron");
    expect(body.detail).toMatch(why);
    expect(created).toEqual([]);
    await app.close();
  });

  it.each(unreadable)("PATCH refuses %j, under `cron`", async (cron, why) => {
    const updated: unknown[] = [];
    const app = await appWith("operator", {
      update: (_id, data) => {
        updated.push(data);
        return Promise.resolve(RECORD);
      },
    });
    const res = await app.inject({ method: "PATCH", url: "/policies/p1", payload: { cron } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; field?: string; detail?: string };
    expect(body.field).toBe("cron");
    expect(body.detail).toMatch(why);
    expect(updated).toEqual([]);
    await app.close();
  });

  it("still accepts the expression the form writes by default", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/policies", payload: { ...CREATE_BODY, cron: "0 2 * * *" } });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

// SC-01. The browser used to compute the next run on the viewer's clock while the scheduler ran on
// UTC. The server answers it now, on the instance's clock, and the UI only renders it.
describe("GET /policies says when each policy next runs, on the instance's clock", () => {
  it("puts a São Paulo 02:00 at 05:00Z", async () => {
    const app = await appWith("viewer", {}, "America/Sao_Paulo");
    const res = await app.inject({ method: "GET", url: "/policies" });
    expect(res.statusCode).toBe(200);
    const [policy] = res.json() as Array<{ cron: string; nextRunAt: string | null }>;
    // RECORD is "0 3 * * *": 03:00 in São Paulo on the 22nd, since 03:00 on the 21st is past.
    expect(policy?.nextRunAt).toBe("2026-09-22T06:00:00.000Z");
    await app.close();
  });

  it("answers null for a disabled policy — nothing will run", async () => {
    const app = await appWith("viewer", { list: () => Promise.resolve([{ ...RECORD, enabled: false }]) });
    const [policy] = (await app.inject({ method: "GET", url: "/policies" })).json() as Array<{ nextRunAt: unknown }>;
    expect(policy?.nextRunAt).toBeNull();
    await app.close();
  });

  // Stored before the route validated it. The list must still answer — it is where the operator
  // finds out — and the row must not claim a run the scheduler will never make.
  it("answers null for a stored cron it cannot read, and still lists the rest", async () => {
    const app = await appWith("viewer", {
      list: () => Promise.resolve([{ ...RECORD, id: "bad", cron: "0 0 30 2 *" }, RECORD]),
    });
    const res = await app.inject({ method: "GET", url: "/policies" });
    expect(res.statusCode).toBe(200);
    const [bad, good] = res.json() as Array<{ id: string; nextRunAt: string | null }>;
    expect(bad).toMatchObject({ id: "bad", nextRunAt: null });
    expect(good?.nextRunAt).toBe("2026-09-22T03:00:00.000Z");
    await app.close();
  });

  it("carries nextRunAt on the single-policy read and on the write responses too", async () => {
    const app = await appWith("operator");
    const one = await app.inject({ method: "GET", url: "/policies/p1" });
    expect((one.json() as { nextRunAt: string }).nextRunAt).toBe("2026-09-22T03:00:00.000Z");
    const created = await app.inject({ method: "POST", url: "/policies", payload: CREATE_BODY });
    expect((created.json() as { nextRunAt: string }).nextRunAt).toBe("2026-09-22T03:00:00.000Z");
    const patched = await app.inject({ method: "PATCH", url: "/policies/p1", payload: { keepLast: 3 } });
    expect((patched.json() as { nextRunAt: string }).nextRunAt).toBe("2026-09-22T03:00:00.000Z");
    await app.close();
  });
});

describe("POST /policies", () => {
  // The product's claim is that a backup is not trusted until a restore has verified it. The default
  // was CHECKSUM — a hash of the bytes — which the roadmap records would have greened the 876-byte
  // artifact and the extension-less dumps. A policy created without saying otherwise must restore.
  it("defaults verifyLevel to FULL_RESTORE, not CHECKSUM", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = await appWith("operator", {
      create: (data) => {
        seen.push(data as unknown as Record<string, unknown>);
        return Promise.resolve(RECORD);
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/policies",
      payload: { name: "nightly", targetId: "t1", destinationId: "d1", cron: "0 3 * * *", keepLast: 7 },
    });
    expect(res.statusCode).toBe(201);
    expect(seen[0]?.verifyLevel).toBe("FULL_RESTORE");
    await app.close();
  });

  it("keeps an explicit CHECKSUM or NONE as asked", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = await appWith("operator", {
      create: (data) => {
        seen.push(data as unknown as Record<string, unknown>);
        return Promise.resolve(RECORD);
      },
    });
    for (const verifyLevel of ["CHECKSUM", "NONE"]) {
      await app.inject({
        method: "POST",
        url: "/policies",
        payload: { name: "n", targetId: "t1", destinationId: "d1", cron: "0 3 * * *", keepLast: 1, verifyLevel },
      });
    }
    expect(seen.map((data) => data.verifyLevel)).toEqual(["CHECKSUM", "NONE"]);
    await app.close();
  });
});

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
