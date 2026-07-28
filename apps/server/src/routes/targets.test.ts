// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { targetRoutes, type TargetRecord, type TargetStore } from "./targets.js";

const RECORD: TargetRecord = {
  id: "t1",
  name: "prod-db",
  engine: "postgres",
  host: "db.internal",
  port: 5432,
  username: "backup",
  tls: true,
  scope: { databases: ["app"], schemas: [], collections: [] },
  encryptedCredential: { v: 1, dek: "WRAPPED-DEK", data: "CIPHERTEXT" },
  createdAt: new Date("2026-07-23T12:00:00Z"),
  updatedAt: new Date("2026-07-23T12:00:00Z"),
};

const STORE: TargetStore = {
  create: () => Promise.resolve(RECORD),
  list: () => Promise.resolve([RECORD]),
  get: () => Promise.resolve(RECORD),
  update: () => Promise.resolve(RECORD),
  remove: () => Promise.resolve({ ok: true }),
};

async function appWith(role: Role | null, over: Partial<TargetStore> = {}) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role };
  await app.register((instance) => {
    targetRoutes({
      resolver: () => Promise.resolve(ctx),
      kek: randomBytes(32),
      store: () => ({ ...STORE, ...over }),
    })(instance);
    return Promise.resolve();
  });
  return app;
}

const CREATE_PAYLOAD = {
  name: "prod-db",
  engine: "postgres",
  host: "db.internal",
  port: 5432,
  username: "backup",
  password: "s3cret-pw",
  tls: true,
  scope: { databases: ["app"], schemas: [], collections: [] },
};

describe("targets — credential is write-only", () => {
  it("never returns the credential on create", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/targets", payload: CREATE_PAYLOAD });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("encryptedCredential");
    expect(res.body).not.toContain("s3cret-pw");
    expect(res.body).not.toContain("WRAPPED-DEK");
    await app.close();
  });

  it("never returns the credential on read", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "GET", url: "/targets/t1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("encryptedCredential");
    expect(res.body).not.toContain("WRAPPED-DEK");
    expect(res.body).not.toContain("CIPHERTEXT");
    const parsed = JSON.parse(res.body) as { host: string };
    expect(parsed.host).toBe("db.internal");
    await app.close();
  });

  it("never returns the credential when listing", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "GET", url: "/targets" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("encryptedCredential");
    expect(res.body).not.toContain("WRAPPED-DEK");
    await app.close();
  });

  it("refuses target creation for a viewer (operator+ only)", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "POST", url: "/targets", payload: CREATE_PAYLOAD });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // M3: an empty-string db name is never a valid scope entry (a [""] scope is ambiguous downstream —
  // resolveVerifyPlan/originDatabaseFor treat it as unscoped). Reject it at the border so it is not
  // storable in the first place.
  it("rejects a scope containing an empty database name (400)", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      payload: { ...CREATE_PAYLOAD, scope: { databases: [""], schemas: [], collections: [] } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("never returns the credential on update", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "PATCH",
      url: "/targets/t1",
      payload: { password: "rotated-pw" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("encryptedCredential");
    expect(res.body).not.toContain("rotated-pw");
    expect(res.body).not.toContain("WRAPPED-DEK");
    await app.close();
  });
});

describe("PATCH /targets/:id", () => {
  // The whole reason a target needs editing: rotating the credential. Omitting the password is how
  // you edit everything else without having to re-supply a secret the UI can never read back.
  it("re-encrypts the credential only when a password is supplied", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = await appWith("operator", {
      update: (_id, data) => {
        seen.push(data as unknown as Record<string, unknown>);
        return Promise.resolve(RECORD);
      },
    });

    await app.inject({ method: "PATCH", url: "/targets/t1", payload: { host: "db2.internal" } });
    expect(seen[0]).not.toHaveProperty("encryptedCredential");
    expect(seen[0]).toMatchObject({ host: "db2.internal" });

    await app.inject({ method: "PATCH", url: "/targets/t1", payload: { password: "rotated-pw" } });
    expect(seen[1]).toHaveProperty("encryptedCredential");
    expect(JSON.stringify(seen[1])).not.toContain("rotated-pw");
    await app.close();
  });

  // A target's engine decides its dump/restore descriptors and its capability matrix. Existing
  // artifacts already record the engine they were taken with; letting it change would make every
  // one of them describe a database that no longer exists at that address.
  it("refuses to change the engine", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "PATCH",
      url: "/targets/t1",
      payload: { engine: "mysql" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an empty patch rather than reporting a no-op as success", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "PATCH", url: "/targets/t1", payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an id outside the caller's organization", async () => {
    const app = await appWith("operator", { update: () => Promise.resolve(null) });
    const res = await app.inject({ method: "PATCH", url: "/targets/nope", payload: { port: 5433 } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a target edit for a viewer (operator+ only)", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "PATCH", url: "/targets/t1", payload: { port: 5433 } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("DELETE /targets/:id", () => {
  it("deletes a target nothing references", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "DELETE", url: "/targets/t1" });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  // A policy points at exactly one target. Deleting it out from under a live policy would leave a
  // schedule that can never run again — and the DB's own restrict would surface as a 500 instead
  // of something the operator can act on.
  it("refuses with 409 and a reason while a policy still references it", async () => {
    const app = await appWith("operator", {
      remove: () => Promise.resolve({ ok: false, reason: "2 policies still reference this target" }),
    });
    const res = await app.inject({ method: "DELETE", url: "/targets/t1" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining("policies") });
    await app.close();
  });

  it("refuses a target delete for a viewer (operator+ only)", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "DELETE", url: "/targets/t1" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
