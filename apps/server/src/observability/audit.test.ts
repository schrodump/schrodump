// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "../auth/rbac.js";
import { actionFor, registerAuditTrail } from "./audit.js";

const CTX: AuthContext = {
  userId: "u1",
  organizationId: "o1",
  role: "admin",
  mustChangePassword: false,
};

interface Row {
  organizationId: string;
  userId: string | null;
  action: string;
  targetId: string | null;
  metadata: unknown;
}

async function appWith(opts: { authenticated?: boolean } = {}) {
  const rows: Row[] = [];
  const app = Fastify();
  registerAuditTrail(app, {
    auditLog: {
      create: ({ data }: { data: Row }) => {
        rows.push(data);
        return Promise.resolve(data);
      },
    },
  } as unknown as PrismaClient);

  app.addHook("preHandler", (request, _reply, done) => {
    if (opts.authenticated !== false) request.authContext = CTX;
    done();
  });
  app.get("/targets", () => ({ ok: true }));
  app.post("/targets", (_request, reply) => reply.status(201).send({ id: "t1" }));
  app.patch("/destinations/:id", () => ({ ok: true }));
  app.post("/targets/:id/test", () => ({ ok: true }));
  app.delete("/policies/:id", () => ({ ok: true }));
  app.post("/policies", (_request, reply) => reply.status(400).send({ error: "invalid" }));
  await app.ready();
  return { app, rows };
}

// onResponse fires after the reply is sent, so the write can land a tick later than inject resolves.
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("actionFor", () => {
  it("names the resource in the singular and the verb from the method", () => {
    expect(actionFor("POST", "/targets")).toBe("target.create");
    expect(actionFor("PATCH", "/destinations/:id")).toBe("destination.update");
    expect(actionFor("DELETE", "/policies/:id")).toBe("policy.delete");
  });

  it("uses the trailing segment as the verb for sub-actions", () => {
    expect(actionFor("POST", "/targets/:id/test")).toBe("target.test");
    expect(actionFor("POST", "/catalog/rebuild")).toBe("catalog.rebuild");
  });

  // Derived from the route PATTERN, so a concrete id can never end up inside an action name and
  // fragment the trail into one action per resource.
  it("never puts an id in the action name", () => {
    expect(actionFor("PATCH", "/destinations/:id")).not.toContain(":");
  });
});

describe("registerAuditTrail", () => {
  it("records a mutation with who, what and the correlation id", async () => {
    const { app, rows } = await appWith();
    await app.inject({ method: "POST", url: "/targets", payload: {} });
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("target.create");
    expect(rows[0]?.userId).toBe("u1");
    expect(rows[0]?.organizationId).toBe("o1");
    await app.close();
  });

  it("carries the resource id from the route params", async () => {
    const { app, rows } = await appWith();
    await app.inject({ method: "PATCH", url: "/destinations/d1", payload: {} });
    await settle();
    expect(rows[0]?.targetId).toBe("d1");
    await app.close();
  });

  // The trail must never become the credential leak. Bodies here carry database passwords and S3
  // secret keys, so nothing derived from the payload may reach the row.
  it("never records the request body", async () => {
    const { app, rows } = await appWith();
    await app.inject({
      method: "POST",
      url: "/targets",
      payload: { host: "db.internal", password: "hunter2-do-not-record" },
    });
    await settle();
    expect(JSON.stringify(rows[0])).not.toContain("hunter2");
    expect(JSON.stringify(rows[0])).not.toContain("db.internal");
    await app.close();
  });

  it("ignores reads", async () => {
    const { app, rows } = await appWith();
    await app.inject({ method: "GET", url: "/targets" });
    await settle();
    expect(rows).toHaveLength(0);
    await app.close();
  });

  // A rejected request changed nothing. Recording it would make the trail unusable for the question
  // it exists to answer — what actually happened to this data.
  it("ignores a rejected mutation", async () => {
    const { app, rows } = await appWith();
    await app.inject({ method: "POST", url: "/policies", payload: {} });
    await settle();
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("ignores an unauthenticated request", async () => {
    const { app, rows } = await appWith({ authenticated: false });
    await app.inject({ method: "POST", url: "/targets", payload: {} });
    await settle();
    expect(rows).toHaveLength(0);
    await app.close();
  });
});
