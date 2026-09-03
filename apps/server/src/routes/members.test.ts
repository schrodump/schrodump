// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthContext, Role } from "../auth/rbac.js";
import { memberRoutes, type MemberRecord, type MemberStore } from "./members.js";

const ADMIN: MemberRecord = {
  userId: "u-admin",
  email: "admin@example.com",
  name: "Admin",
  role: "admin",
  mustChangePassword: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const VIEWER: MemberRecord = { ...ADMIN, userId: "u-viewer", email: "v@example.com", name: "V", role: "viewer" };

function baseStore(): MemberStore {
  return {
    list: () => Promise.resolve([ADMIN, VIEWER]),
    create: (data) =>
      Promise.resolve({
        userId: "u-new",
        email: data.email,
        name: data.name,
        role: data.role,
        mustChangePassword: true,
        createdAt: new Date("2026-09-03T00:00:00.000Z"),
      }),
    updateRole: (userId, role) => Promise.resolve({ ...VIEWER, userId, role }),
    remove: () => Promise.resolve(true),
    countAdmins: () => Promise.resolve(2),
    roleOf: (userId) => Promise.resolve(userId === "u-admin" ? "admin" : "viewer"),
  };
}

async function appWith(role: Role | null, over: Partial<MemberStore> = {}, userId = "u-admin") {
  const app = Fastify();
  const ctx: AuthContext | null =
    role === null ? null : { userId, organizationId: "o", role, mustChangePassword: false };
  await app.register((instance) => {
    memberRoutes({
      resolver: () => Promise.resolve(ctx),
      store: () => ({ ...baseStore(), ...over }),
    })(instance);
    return Promise.resolve();
  });
  return app;
}

describe("members — who may see and change them", () => {
  it("lets an admin list the organization's members", async () => {
    const app = await appWith("admin");
    const res = await app.inject({ method: "GET", url: "/members" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    await app.close();
  });

  it("refuses every verb to an operator — membership is an admin concern", async () => {
    const app = await appWith("operator");
    for (const [method, url] of [
      ["GET", "/members"],
      ["POST", "/members"],
      ["PATCH", "/members/u-viewer"],
      ["DELETE", "/members/u-viewer"],
    ] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(403);
    }
    await app.close();
  });

  it("refuses without a session", async () => {
    const app = await appWith(null);
    expect((await app.inject({ method: "GET", url: "/members" })).statusCode).toBe(401);
    await app.close();
  });

  it("never returns a password hash, whatever the store holds", async () => {
    const app = await appWith("admin");
    const body = (await app.inject({ method: "GET", url: "/members" })).body;
    expect(body).not.toContain("hash");
    expect(body).not.toContain("password");
    await app.close();
  });
});

describe("members — creating one", () => {
  it("returns the temporary password ONCE, and it is the one the store was given", async () => {
    // The admin has to be able to hand it over. It is a shared secret until rotated — exactly what
    // docs/security.md already says about the bootstrap password — which is why the account is
    // created with mustChangePassword and can do nothing until it is changed.
    let given = "";
    const app = await appWith("admin", {
      create: (data) => {
        given = data.password;
        return Promise.resolve({
          userId: "u-new",
          email: data.email,
          name: data.name,
          role: data.role,
          mustChangePassword: true,
          createdAt: new Date(),
        });
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/members",
      payload: { email: "new@example.com", name: "New", role: "operator" },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { temporaryPassword: string; member: MemberRecord };
    expect(created.temporaryPassword).toBe(given);
    expect(created.member.role).toBe("operator");
    expect(created.member.mustChangePassword).toBe(true);
    await app.close();
  });

  it("generates a password the server's own floor would accept", async () => {
    // minPasswordLength is 12 in createAuth. A generated secret shorter than the floor would be
    // refused by Better-Auth at creation, which is a 500 for the admin and no account.
    const app = await appWith("admin");
    const res = await app.inject({
      method: "POST",
      url: "/members",
      payload: { email: "new@example.com", name: "New", role: "viewer" },
    });
    expect((res.json() as { temporaryPassword: string }).temporaryPassword.length).toBeGreaterThanOrEqual(12);
    await app.close();
  });

  it("answers 409 for an email already taken, not a 500", async () => {
    const app = await appWith("admin", { create: () => Promise.resolve(null) });
    const res = await app.inject({
      method: "POST",
      url: "/members",
      payload: { email: "admin@example.com", name: "Dup", role: "viewer" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("refuses a role outside the three the product has", async () => {
    const app = await appWith("admin");
    const res = await app.inject({
      method: "POST",
      url: "/members",
      payload: { email: "new@example.com", name: "New", role: "superuser" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("members — the last admin cannot be removed or demoted", () => {
  // There is no second setup token and no way back in: the setup route is consumed, and the
  // environment path only ever creates the FIRST admin. An organization with no admin is an
  // organization whose keys, destinations and members nobody can ever administer again.
  it("refuses to demote the only admin", async () => {
    const app = await appWith("admin", { countAdmins: () => Promise.resolve(1) });
    const res = await app.inject({
      method: "PATCH",
      url: "/members/u-admin",
      payload: { role: "operator" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/admin/i);
    await app.close();
  });

  it("refuses to remove the only admin", async () => {
    const app = await appWith("admin", { countAdmins: () => Promise.resolve(1) }, "u-other");
    const res = await app.inject({ method: "DELETE", url: "/members/u-admin" });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("allows demoting an admin while another one remains", async () => {
    const app = await appWith("admin", { countAdmins: () => Promise.resolve(2) });
    const res = await app.inject({
      method: "PATCH",
      url: "/members/u-admin",
      payload: { role: "operator" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("refuses to remove yourself, which would end the session doing it", async () => {
    const app = await appWith("admin", {}, "u-admin");
    const res = await app.inject({ method: "DELETE", url: "/members/u-admin" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/yourself/i);
    await app.close();
  });

  it("removes another member", async () => {
    const app = await appWith("admin", {}, "u-admin");
    const res = await app.inject({ method: "DELETE", url: "/members/u-viewer" });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("answers 404 for a member of another organization", async () => {
    const app = await appWith("admin", { roleOf: () => Promise.resolve(null) });
    const res = await app.inject({ method: "DELETE", url: "/members/u-elsewhere" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
