// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { sessionRoutes } from "./session.js";

async function appWith(ctx: AuthContext | null, timeZone = "UTC") {
  const app = Fastify();
  await app.register((instance) => {
    sessionRoutes(() => Promise.resolve(ctx), { timeZone })(instance);
    return Promise.resolve();
  });
  return app;
}

describe("GET /me", () => {
  it("returns the caller's resolved context so the UI can learn its role", async () => {
    const app = await appWith({ userId: "u1", organizationId: "o1", role: "operator" satisfies Role , mustChangePassword: false });
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ userId: "u1", organizationId: "o1", role: "operator" , mustChangePassword: false, timeZone: "UTC" });
    await app.close();
  });

  // The zone every cron is read in, for every role: the policy form previews the next run on the
  // scheduler's clock before any policy exists, and a viewer reads the same schedules an admin does.
  it("tells a viewer the instance's time zone", async () => {
    const app = await appWith(
      { userId: "u2", organizationId: "o1", role: "viewer", mustChangePassword: false },
      "America/Sao_Paulo",
    );
    const res = await app.inject({ method: "GET", url: "/me" });
    expect((res.json() as { timeZone: string }).timeZone).toBe("America/Sao_Paulo");
    await app.close();
  });

  it("401 when the request is not authenticated", async () => {
    const app = await appWith(null);
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
