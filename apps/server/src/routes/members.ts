// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type Role, type SessionResolver } from "../auth/rbac.js";

// Roles have been enforced since the first migration; until now there was no way to give anyone
// one. The bootstrap creates the FIRST admin and the setup token is consumed, so a deployment was
// permanently single-user — a product with three roles and one seat.
const RoleSchema = z.enum(["admin", "operator", "viewer"]);
const CreateSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  role: RoleSchema,
});
const UpdateSchema = z.object({ role: RoleSchema }).strict();
const IdParams = z.object({ id: z.string().min(1) });

export interface MemberRecord {
  userId: string;
  email: string;
  name: string;
  role: Role;
  // True until the member has changed the password they were handed. requireRole refuses EVERY
  // action while it stands, for every role — so an account created here can do nothing at all
  // until the person holding it has rotated the secret an admin read off a screen.
  mustChangePassword: boolean;
  createdAt: Date;
}

export interface MemberStore {
  list(): Promise<MemberRecord[]>;
  // null when the email is already taken — a collision is an answer, not a crash.
  create(data: {
    email: string;
    name: string;
    role: Role;
    password: string;
  }): Promise<MemberRecord | null>;
  updateRole(userId: string, role: Role): Promise<MemberRecord | null>;
  remove(userId: string): Promise<boolean>;
  countAdmins(): Promise<number>;
  // null when no membership with that userId exists in the caller's organization.
  roleOf(userId: string): Promise<Role | null>;
}

export interface MemberRoutesDeps {
  resolver: SessionResolver;
  store(organizationId: string): MemberStore;
}

// 24 characters of base64url from the system CSPRNG, comfortably over the server's own
// minPasswordLength floor of 12. Generated here rather than accepted from the admin: a password
// chosen in a form is a password chosen badly and then reused, and this one exists to be replaced
// on first use anyway.
function temporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

export function memberRoutes(deps: MemberRoutesDeps) {
  return (app: FastifyInstance): void => {
    // admin throughout: who may take a backup, restore over a live database or read the catalog is
    // exactly what these rows decide.
    const guard = { preHandler: [authenticate(deps.resolver), requireRole("admin")] };

    app.get("/members", guard, async (request, reply) =>
      reply.send(await deps.store(contextOf(request).organizationId).list()),
    );

    app.post("/members", guard, async (request, reply) => {
      const parsed = CreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid member" });
      const password = temporaryPassword();
      const member = await deps
        .store(contextOf(request).organizationId)
        .create({ ...parsed.data, password });
      if (member === null) return reply.status(409).send({ error: "email already in use" });
      // The one and only time this value is readable. It is a shared secret until rotated — the
      // same status docs/security.md gives the bootstrap password — which is why the account
      // carries mustChangePassword and can do nothing before it is changed.
      return reply.status(201).send({ temporaryPassword: password, member });
    });

    app.patch("/members/:id", guard, async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: "invalid id" });
      const body = UpdateSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: "invalid role" });
      const store = deps.store(contextOf(request).organizationId);
      const current = await store.roleOf(params.data.id);
      if (current === null) return reply.status(404).send({ error: "no such member" });
      if (current === "admin" && body.data.role !== "admin" && (await store.countAdmins()) === 1) {
        return reply.status(409).send({ error: "the last admin cannot be demoted" });
      }
      const updated = await store.updateRole(params.data.id, body.data.role);
      if (updated === null) return reply.status(404).send({ error: "no such member" });
      return reply.send(updated);
    });

    app.delete("/members/:id", guard, async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: "invalid id" });
      const ctx = contextOf(request);
      // Checked before anything else: it is the only refusal here that protects the caller from
      // themselves rather than the organization from being stranded.
      if (params.data.id === ctx.userId) {
        return reply.status(409).send({ error: "you cannot remove yourself" });
      }
      const store = deps.store(ctx.organizationId);
      const current = await store.roleOf(params.data.id);
      if (current === null) return reply.status(404).send({ error: "no such member" });
      // There is no second setup token and no way back in — the setup route is consumed and the
      // environment path only ever creates the FIRST admin. An organization with no admin is one
      // whose keys, destinations and members nobody can administer again.
      if (current === "admin" && (await store.countAdmins()) === 1) {
        return reply.status(409).send({ error: "the last admin cannot be removed" });
      }
      const removed = await store.remove(params.data.id);
      if (!removed) return reply.status(404).send({ error: "no such member" });
      return reply.status(204).send();
    });
  };
}
