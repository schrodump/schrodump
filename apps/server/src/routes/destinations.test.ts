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
  update: () => Promise.resolve(RECORD),
  remove: () => Promise.resolve({ ok: true }),
};

async function appWith(role: Role | null, over: Partial<DestinationStore> = {}) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role };
  await app.register((instance) => {
    destinationRoutes({
      resolver: () => Promise.resolve(ctx),
      kek: randomBytes(32),
      store: () => ({ ...STORE, ...over }),
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

  it("never returns the secret on update", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "PATCH",
      url: "/destinations/d1",
      payload: { secretAccessKey: "rotated-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("rotated-key");
    expect(res.body).not.toContain("WRAPPED-DEK");
    await app.close();
  });
});

describe("PATCH /destinations/:id", () => {
  // Key rotation is the reason this route exists. Omitting the secret edits everything else
  // without re-supplying a value the UI can never read back.
  it("re-encrypts the secret only when one is supplied", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = await appWith("operator", {
      update: (_id, data) => {
        seen.push(data as unknown as Record<string, unknown>);
        return Promise.resolve(RECORD);
      },
    });

    await app.inject({ method: "PATCH", url: "/destinations/d1", payload: { region: "eu-west-1" } });
    expect(seen[0]).not.toHaveProperty("encryptedSecretAccessKey");
    expect(seen[0]).toMatchObject({ region: "eu-west-1" });

    await app.inject({
      method: "PATCH",
      url: "/destinations/d1",
      payload: { secretAccessKey: "rotated-key" },
    });
    expect(seen[1]).toHaveProperty("encryptedSecretAccessKey");
    expect(JSON.stringify(seen[1])).not.toContain("rotated-key");
    await app.close();
  });

  // Every artifact's bucketKey and manifestKey are built from the destination's bucket and prefix
  // at write time and stored relative to them. Repointing either one leaves the whole catalogue
  // describing objects at addresses that no longer hold them — the backups are still in the old
  // bucket, and nothing left in the system knows where that is.
  it.each(["bucket", "prefix"] as const)(
    "refuses to change %s, which would strand every existing artifact",
    async (field) => {
      const app = await appWith("operator");
      const res = await app.inject({
        method: "PATCH",
        url: "/destinations/d1",
        payload: { [field]: "moved" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    },
  );

  it("rejects an empty patch", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "PATCH", url: "/destinations/d1", payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("refuses a destination edit for a viewer", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({
      method: "PATCH",
      url: "/destinations/d1",
      payload: { region: "eu-west-1" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("DELETE /destinations/:id", () => {
  it("deletes a destination nothing references", async () => {
    const app = await appWith("operator");
    const res = await app.inject({ method: "DELETE", url: "/destinations/d1" });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  // The sharpest one. A destination row holds the only credentials the system has for that bucket;
  // deleting it while artifacts point there does not delete the backups, it makes them
  // unreachable — a catalogue full of entries nobody can restore from. That has to be refused, not
  // cascaded.
  it("refuses with 409 while artifacts still live in it", async () => {
    const app = await appWith("operator", {
      remove: () =>
        Promise.resolve({ ok: false, reason: "12 artifacts are still stored in this destination" }),
    });
    const res = await app.inject({ method: "DELETE", url: "/destinations/d1" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining("artifacts") });
    await app.close();
  });

  it("refuses a destination delete for a viewer", async () => {
    const app = await appWith("viewer");
    const res = await app.inject({ method: "DELETE", url: "/destinations/d1" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
