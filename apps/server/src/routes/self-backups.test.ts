// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { selfBackupRoutes } from "./self-backups.js";

const ROW = {
  id: "sb-1",
  state: "SUCCEEDED" as const,
  organizationId: "org-1",
  destinationId: "dest-1",
  bucketKey: "backups/_self/sb-1/metadata.bin",
  manifestKey: "backups/_self/sb-1/self-backup.json",
  sizeBytes: 4096n,
  checksum: "deadbeef",
  keyIds: ["esc", "ops"],
  reason: null,
  startedAt: new Date("2026-09-01T00:00:00Z"),
  finishedAt: new Date("2026-09-01T00:01:00Z"),
};

async function appWith(role: Role | null, opts: { configured?: boolean; rows?: unknown[] } = {}) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role , mustChangePassword: false };
  await app.register((instance) => {
    selfBackupRoutes({
      resolver: () => Promise.resolve(ctx),
      prisma: {
        selfBackup: { findMany: () => Promise.resolve(opts.rows ?? [ROW]) },
      } as unknown as PrismaClient,
      configuredDestinationId: opts.configured === false ? null : "dest-1",
    })(instance);
    return Promise.resolve();
  });
  return app;
}

describe("GET /self-backups", () => {
  it("returns the recent runs to an admin, with BigInt size coerced for JSON", async () => {
    const app = await appWith("admin");
    const res = await app.inject({ method: "GET", url: "/self-backups" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { configured: boolean; items: { sizeBytes: number }[] };
    expect(body.configured).toBe(true);
    // BigInt reaching JSON.stringify throws "Do not know how to serialize a BigInt" and turns a
    // working endpoint into a 500 the moment the first self-backup actually uploads something.
    expect(body.items[0]?.sizeBytes).toBe(4096);
    await app.close();
  });

  // An empty list on an unconfigured deployment reads exactly like an empty list on a configured
  // one that has never run — the ambiguity this product exists to remove. The flag separates them.
  it("reports configured: false when no destination is set, even with no rows", async () => {
    const app = await appWith("admin", { configured: false, rows: [] });
    const res = await app.inject({ method: "GET", url: "/self-backups" });
    expect(JSON.parse(res.body)).toEqual({ configured: false, items: [] });
    await app.close();
  });

  it("refuses an operator (admin only)", async () => {
    const app = await appWith("operator");
    expect((await app.inject({ method: "GET", url: "/self-backups" })).statusCode).toBe(403);
    await app.close();
  });
});
