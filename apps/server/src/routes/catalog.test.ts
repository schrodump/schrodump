// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { catalogRoutes } from "./catalog.js";

async function appWith(role: Role | null) {
  const app = Fastify();
  const ctx: AuthContext | null = role === null ? null : { userId: "u", organizationId: "o", role };
  await app.register((instance) => {
    catalogRoutes({
      resolver: () => Promise.resolve(ctx),
      rebuild: () => Promise.resolve({ scanned: 3, imported: ["j1", "j3"], skipped: ["j2"] }),
    })(instance);
    return Promise.resolve();
  });
  return app;
}

describe("POST /catalog/rebuild", () => {
  it("lets an admin rebuild the catalog from the bucket", async () => {
    const app = await appWith("admin");
    const res = await app.inject({
      method: "POST",
      url: "/catalog/rebuild",
      payload: { destinationId: "d1" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ scanned: 3, imported: ["j1", "j3"], skipped: ["j2"] });
    await app.close();
  });

  it("refuses an operator (admin only)", async () => {
    const app = await appWith("operator");
    const res = await app.inject({
      method: "POST",
      url: "/catalog/rebuild",
      payload: { destinationId: "d1" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
