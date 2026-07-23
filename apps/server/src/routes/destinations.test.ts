// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { destinationRoutes, type DestinationRecord, type DestinationStore } from "./destinations.js";

const RECORD: DestinationRecord = {
  id: "d1",
  name: "prod-s3",
  endpoint: null,
  region: "us-east-1",
  bucket: "backups",
  prefix: "schrodump",
  accessKeyId: "AKIAEXAMPLE",
  encryptedSecretAccessKey: { v: 1, dek: "WRAPPED-DEK", data: "CIPHERTEXT" },
  forcePathStyle: false,
  sealMode: "operational",
};

const STORE: DestinationStore = {
  create: () => Promise.resolve(RECORD),
  list: () => Promise.resolve([RECORD]),
  get: () => Promise.resolve(RECORD),
};

async function appWith(role: Role | null) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role };
  await app.register((instance) => {
    destinationRoutes({
      resolver: () => Promise.resolve(ctx),
      kek: randomBytes(32),
      store: () => STORE,
      canary: () => Promise.resolve({ ok: true, failedOperation: null }),
    })(instance);
    return Promise.resolve();
  });
  return app;
}

const PAYLOAD = {
  name: "prod-s3",
  region: "us-east-1",
  bucket: "backups",
  prefix: "schrodump",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cret-key",
  forcePathStyle: false,
  sealMode: "operational",
};

describe("destinations — secret is write-only", () => {
  it("never returns the secret on create", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/destinations", payload: PAYLOAD });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("s3cret-key");
    expect(res.body).not.toContain("encryptedSecretAccessKey");
    expect(res.body).not.toContain("WRAPPED-DEK");
    await app.close();
  });

  it("never returns the secret on list", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "GET", url: "/destinations" });
    expect(res.body).not.toContain("WRAPPED-DEK");
    await app.close();
  });

  it("refuses creation for a viewer", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "POST", url: "/destinations", payload: PAYLOAD });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("runs the canary for an operator", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "POST", url: "/destinations/d1/canary" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, failedOperation: null });
    await app.close();
  });
});
