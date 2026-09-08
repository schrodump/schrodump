// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext, Role } from "../auth/rbac.js";
import { auditRoutes, prismaAuditStore, type AuditStore } from "./audit.js";

const store: AuditStore = {
  list: () =>
    Promise.resolve({
      items: [
        {
          id: "a1",
          action: "restore.execute",
          targetType: "artifacts",
          targetId: "art1",
          correlationId: "restore:art1",
          actorEmail: "admin@example.com",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      total: 1,
    }),
};

async function appWith(role: Role | null) {
  const app = Fastify();
  const ctx: AuthContext | null =
    role === null ? null : { userId: "u", organizationId: "o", role, mustChangePassword: false };
  await app.register((instance) => {
    auditRoutes({ resolver: () => Promise.resolve(ctx), store: () => store })(instance);
    return Promise.resolve();
  });
  return app;
}

describe("audit routes", () => {
  it("lets an admin read the trail (200)", async () => {
    const app = await appWith("admin");
    const res = await app.inject({ method: "GET", url: "/audit-log" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items[0].action).toBe("restore.execute");
    await app.close();
  });

  it("refuses an operator (403) — reading the trail is itself a privileged act", async () => {
    const app = await appWith("operator");
    expect((await app.inject({ method: "GET", url: "/audit-log" })).statusCode).toBe(403);
    await app.close();
  });

  it("refuses a viewer (403)", async () => {
    const app = await appWith("viewer");
    expect((await app.inject({ method: "GET", url: "/audit-log" })).statusCode).toBe(403);
    await app.close();
  });
});

describe("prismaAuditStore", () => {
  interface Op {
    model: string;
    operation: string;
    args: Record<string, unknown>;
    query: (a: Record<string, unknown>) => Promise<unknown>;
  }
  function fakePrisma(rows: unknown[]) {
    const calls: { operation: string; args: Record<string, unknown> }[] = [];
    let wrap: ((op: Op) => Promise<unknown>) | null = null;
    const call = (operation: string, args: Record<string, unknown>, result: unknown) => {
      const run = (final: Record<string, unknown>) => {
        calls.push({ operation, args: final });
        return Promise.resolve(result);
      };
      return wrap === null ? run(args) : wrap({ model: "AuditLog", operation, args, query: run });
    };
    const base = {
      auditLog: {
        findMany: (a: Record<string, unknown>) => call("findMany", a, rows),
        count: (a: Record<string, unknown>) => call("count", a, rows.length),
      },
      $extends: (ext: { query: { $allModels: { $allOperations: (op: Op) => Promise<unknown> } } }) => {
        wrap = ext.query.$allModels.$allOperations;
        return base;
      },
    };
    return { calls, prisma: base as unknown as PrismaClient };
  }

  it("resolves the actor email from the user relation, and keeps null for a job's credential read", async () => {
    const f = fakePrisma([
      {
        id: "a1",
        action: "restore.execute",
        targetType: "artifacts",
        targetId: "art1",
        correlationId: "restore:art1",
        user: { email: "admin@example.com" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "a2",
        action: "credential.read",
        targetType: null,
        targetId: null,
        correlationId: "backup:p1",
        user: null,
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
    ]);
    const result = await prismaAuditStore(f.prisma, "org-1").list();
    expect(result.total).toBe(2);
    expect(result.items[0]?.actorEmail).toBe("admin@example.com");
    // The null is load-bearing: a job has no user, and "system" is decided in the UI, never here by
    // minting an email the row does not have.
    expect(result.items[1]?.actorEmail).toBeNull();
    // Scoped and bounded: the org filter is injected by scopedPrisma, and the page is capped.
    const find = f.calls.find((c) => c.operation === "findMany");
    expect((find?.args as { where?: { organizationId?: string } }).where?.organizationId).toBe("org-1");
    expect((find?.args as { take?: number }).take).toBeGreaterThan(0);
  });
});
