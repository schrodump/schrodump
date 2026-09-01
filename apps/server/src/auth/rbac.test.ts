// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { canTriggerRestore, hasAtLeast, requireRole, type AuthContext, type Role } from "./rbac.js";

describe("role hierarchy", () => {
  it("ranks admin >= operator >= viewer", () => {
    expect(hasAtLeast("admin", "operator")).toBe(true);
    expect(hasAtLeast("operator", "operator")).toBe(true);
    expect(hasAtLeast("viewer", "operator")).toBe(false);
    expect(hasAtLeast("operator", "admin")).toBe(false);
  });

  it("lets operator and admin trigger restore but never viewer", () => {
    const allowed: Role[] = ["admin", "operator"];
    for (const role of allowed) expect(canTriggerRestore(role)).toBe(true);
    expect(canTriggerRestore("viewer")).toBe(false);
  });
});

// A tiny stand-in for the Fastify request/reply pair, enough to observe what a preHandler does.
function fakeExchange(authContext?: AuthContext) {
  const sent: { status: number; body: unknown }[] = [];
  const reply = {
    status(code: number) {
      return {
        send(body: unknown) {
          sent.push({ status: code, body });
          return undefined;
        },
      };
    },
  };
  return { request: { authContext } as FastifyRequest, reply: reply as unknown as FastifyReply, sent };
}

const ADMIN: AuthContext = {
  userId: "u1",
  organizationId: "o1",
  role: "admin",
  mustChangePassword: false,
};

describe("requireRole", () => {
  it("lets a sufficient role through", async () => {
    const x = fakeExchange(ADMIN);
    expect(await requireRole("operator")(x.request, x.reply)).toBeUndefined();
    expect(x.sent).toHaveLength(0);
  });

  it("refuses an insufficient role", async () => {
    const x = fakeExchange({ ...ADMIN, role: "viewer" });
    await requireRole("operator")(x.request, x.reply);
    expect(x.sent[0]?.status).toBe(403);
  });

  // The bootstrap admin's password arrives through SCHRODUMP_ADMIN_PASSWORD, which is readable in
  // `docker inspect` and sits in .env on disk. The schema has always set mustChangePassword for
  // exactly that reason, and until now nothing read it: the flag was written and never enforced.
  // Every route that DOES anything goes through requireRole, so this is where it has to bite.
  it("refuses every action while the password still has to be rotated, whatever the role", async () => {
    for (const role of ["admin", "operator", "viewer"] as const) {
      const x = fakeExchange({ ...ADMIN, role, mustChangePassword: true });
      await requireRole("viewer")(x.request, x.reply);
      expect(x.sent[0]?.status).toBe(403);
      // A machine-readable code, not prose: the UI has to tell this apart from a plain permission
      // denial to send the operator to the right screen.
      expect(x.sent[0]?.body).toEqual({ error: "password_rotation_required" });
    }
  });
});
