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
};

async function appWith(role: Role | null) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role };
  await app.register((instance) => {
    targetRoutes({
      resolver: () => Promise.resolve(ctx),
      kek: randomBytes(32),
      store: () => STORE,
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
});
