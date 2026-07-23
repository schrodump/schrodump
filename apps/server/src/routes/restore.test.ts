// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, SessionResolver } from "../auth/rbac.js";
import { restoreRoutes } from "./restore.js";

async function appWith(ctx: AuthContext | null) {
  const app = Fastify();
  const resolver: SessionResolver = () => Promise.resolve(ctx);
  await app.register(async (instance) => {
    restoreRoutes(resolver)(instance);
  });
  return app;
}

describe("POST /artifacts/:id/restore", () => {
  it("refuses a viewer with 403 (audit requirement, not convenience)", async () => {
    const app = await appWith({ userId: "u", organizationId: "o", role: "viewer" });
    const res = await app.inject({ method: "POST", url: "/artifacts/a1/restore" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("lets an operator through to the not-yet-implemented restore (501)", async () => {
    const app = await appWith({ userId: "u", organizationId: "o", role: "operator" });
    const res = await app.inject({ method: "POST", url: "/artifacts/a1/restore" });
    expect(res.statusCode).toBe(501);
    await app.close();
  });

  it("returns 401 when unauthenticated", async () => {
    const app = await appWith(null);
    const res = await app.inject({ method: "POST", url: "/artifacts/a1/restore" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
