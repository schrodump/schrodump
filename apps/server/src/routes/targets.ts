// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";
import { encryptCredential, type EncryptedCredential } from "../crypto/envelope.js";
import { definedOnly } from "../data/patch.js";
import { scopedPrisma } from "../data/scope.js";
import type { ProbeTarget, TestConnectionResult } from "../probe/test-connection.js";

const EngineSchema = z.enum(["postgres", "mysql", "mariadb", "mongodb"]);
const ScopeSchema = z.object({
  // An empty db name is never a valid scope entry: it is not storable here, and downstream a `[""]`
  // scope is ambiguous — resolveVerifyPlan/originDatabaseFor (worker-wiring.ts) treat it as unscoped.
  // Reject it at the border so the two can never disagree over what a stored scope means.
  databases: z.array(z.string().min(1)),
  schemas: z.array(z.string()),
  collections: z.array(z.string()),
});

// The password is write-only: it is encrypted into `encryptedCredential` and never echoed.
const CreateTargetSchema = z.object({
  name: z.string().min(1),
  engine: EngineSchema,
  host: z.string().min(1),
  port: z.number().int(),
  username: z.string().min(1),
  password: z.string().min(1),
  tls: z.boolean().default(true),
  scope: ScopeSchema,
});

// Editable fields only, all optional. `engine` is deliberately absent and `.strict()` turns sending
// it into a 400 rather than a silent no-op: the engine decides a target's dump/restore descriptors
// and capability matrix, and every artifact already taken records the engine it was taken with.
// Repointing it would make that whole history describe something that is no longer there.
//
// `password` keeps the write-only contract in both directions: omit it and the stored credential is
// untouched, which is what makes editing a host or port possible at all when the UI can never read
// the secret back to re-submit it.
const UpdateTargetSchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int(),
    username: z.string().min(1),
    password: z.string().min(1),
    tls: z.boolean(),
    scope: ScopeSchema,
  })
  .partial()
  .strict();

type EngineName = z.infer<typeof EngineSchema>;

// The connection alone — everything a probe needs and nothing that would be stored. Used by
// /targets/discover so an operator can see what a server holds BEFORE a target exists.
const DiscoverSchema = z.object({
  engine: EngineSchema,
  host: z.string().min(1),
  port: z.number().int(),
  username: z.string().min(1),
  password: z.string().min(1),
  tls: z.boolean().default(true),
});

// What a scope has to look like for the dump tool to copy what the operator meant. Enforced at
// the border, and again at dump time by buildDumpDescriptorFor (jobs/worker-wiring.ts): the two
// locks are deliberate, because the second one was the only one for long enough to ship a backup
// of the wrong database. A postgres target with no database dumped `postgres` — the maintenance
// database — while a 9.4 GB one sat untouched beside it, under a SUCCEEDED job. Refusing here
// means that target cannot be created at all, which is where the mistake is cheapest.
//
// The message is the error body, verbatim, because it is written for the person who has to fix it.
export function scopeProblem(engine: EngineName, scope: { databases: string[] }): string | null {
  const count = scope.databases.length;
  if (engine === "postgres" && count !== 1) {
    return count === 0
      ? "a postgres target must name exactly one database: pg_dump copies one per run, and " +
          "without a name it would copy `postgres`, the maintenance database"
      : "a postgres target must name exactly one database: pg_dump copies one per run, so " +
          `${count} names would back up only the first — create one target per database`;
  }
  if (engine === "mongodb" && count > 1) {
    return "a mongodb target names at most one database, or none for the whole instance (which " +
      "is also what a replica set requires)";
  }
  return null;
}

// Derived from the schema rather than from CreateTargetData: Zod's `.partial()` produces
// `k?: T | undefined`, and under exactOptionalPropertyTypes that is a different type from `k?: T`.
export type UpdateTargetData = Omit<z.infer<typeof UpdateTargetSchema>, "password"> & {
  encryptedCredential?: EncryptedCredential | undefined;
};

// Whether the row could be removed, or why not. A dependency is a refusal the operator can act on
// (drop the policy first), not a 500 from the database's own restrict.
export interface RemoveResult {
  ok: boolean;
  reason?: string;
}

export interface CreateTargetData {
  name: string;
  engine: EngineName;
  host: string;
  port: number;
  username: string;
  tls: boolean;
  scope: z.infer<typeof ScopeSchema>;
  encryptedCredential: EncryptedCredential;
}

export interface TargetRecord {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  username: string;
  tls: boolean;
  scope: unknown;
  // Present in the store, NEVER included in a response.
  encryptedCredential: unknown;
  createdAt: Date;
  updatedAt: Date;
  // The last operator-triggered connection probe. null across all three means it has never been
  // run — a different state from "run and refused", which the setup checklist must tell apart.
  // The failure is the CODE, never the driver's message: driver errors embed the credential they
  // failed with, and this column is handed to every viewer.
  lastProbeAt: Date | null;
  lastProbeOk: boolean | null;
  lastProbeFailure: string | null;
}

export interface TargetStore {
  create(data: CreateTargetData): Promise<TargetRecord>;
  list(): Promise<TargetRecord[]>;
  get(id: string): Promise<TargetRecord | null>;
  // null when no row with that id exists in the caller's organization.
  update(id: string, data: UpdateTargetData): Promise<TargetRecord | null>;
  remove(id: string): Promise<RemoveResult>;
}

interface PublicTarget {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  username: string;
  tls: boolean;
  scope: unknown;
  createdAt: Date;
  updatedAt: Date;
  lastProbeAt: Date | null;
  lastProbeOk: boolean | null;
  lastProbeFailure: string | null;
}

function toPublicTarget(target: TargetRecord): PublicTarget {
  return {
    id: target.id,
    name: target.name,
    engine: target.engine,
    host: target.host,
    port: target.port,
    username: target.username,
    tls: target.tls,
    scope: target.scope,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    lastProbeAt: target.lastProbeAt,
    lastProbeOk: target.lastProbeOk,
    lastProbeFailure: target.lastProbeFailure,
  };
}

export interface TargetRoutesDeps {
  resolver: SessionResolver;
  kek: Buffer;
  store(organizationId: string): TargetStore;
  // Opens a real connection with the given credentials and reports what is there. Injected so the
  // route is testable without a database, exactly as the store is.
  probe(target: ProbeTarget): Promise<TestConnectionResult>;
}

export function targetRoutes(deps: TargetRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.post(
      "/targets",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const parsed = CreateTargetSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid target" });
        const problem = scopeProblem(parsed.data.engine, parsed.data.scope);
        if (problem !== null) return reply.status(400).send({ error: problem });
        const created = await deps.store(contextOf(request).organizationId).create({
          name: parsed.data.name,
          engine: parsed.data.engine,
          host: parsed.data.host,
          port: parsed.data.port,
          username: parsed.data.username,
          tls: parsed.data.tls,
          scope: parsed.data.scope,
          encryptedCredential: encryptCredential(deps.kek, parsed.data.password),
        });
        return reply.status(201).send(toPublicTarget(created));
      },
    );

    // Lists what a server holds before any target exists, so the scope can be chosen from what is
    // actually there rather than typed. Nothing is persisted: the password in the body is used for
    // this one connection and discarded, the same posture as the password on create. The
    // connection is opened exactly as the backup's own probe would open it — unscoped, through the
    // engine's maintenance database — so "discovery works" also means "the backup can probe".
    app.post(
      "/targets/discover",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const parsed = DiscoverSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid connection" });
        const result = await deps.probe({ ...parsed.data, databases: [] });
        return reply.send(result);
      },
    );

    app.get(
      "/targets",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => {
        const list = await deps.store(contextOf(request).organizationId).list();
        return reply.send(list.map(toPublicTarget));
      },
    );

    app.get(
      "/targets/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const target = await deps.store(contextOf(request).organizationId).get(params.data.id);
        if (target === null) return reply.status(404).send({ error: "not found" });
        return reply.send(toPublicTarget(target));
      },
    );

    app.patch(
      "/targets/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const parsed = UpdateTargetSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid target update" });

        const { password, ...rest } = parsed.data;
        // An empty patch is a request that says nothing. Answering 200 would report a change that
        // never happened, which is exactly the kind of false success this project refuses to emit.
        if (password === undefined && Object.keys(rest).length === 0) {
          return reply.status(400).send({ error: "no fields to update" });
        }

        const store = deps.store(contextOf(request).organizationId);
        // The engine is not in a patch — it cannot be changed — so the rule reads it off the row.
        // One extra query, only when the scope itself is what is being changed.
        if (rest.scope !== undefined) {
          const current = await store.get(params.data.id);
          if (current === null) return reply.status(404).send({ error: "not found" });
          const problem = scopeProblem(current.engine as EngineName, rest.scope);
          if (problem !== null) return reply.status(400).send({ error: problem });
        }

        const updated = await store.update(params.data.id, {
          ...rest,
          ...(password !== undefined
            ? { encryptedCredential: encryptCredential(deps.kek, password) }
            : {}),
        });
        if (updated === null) return reply.status(404).send({ error: "not found" });
        return reply.send(toPublicTarget(updated));
      },
    );

    app.delete(
      "/targets/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const result = await deps.store(contextOf(request).organizationId).remove(params.data.id);
        // 409, not 500: "a policy still points at this" is a state the operator can resolve, and
        // the reason has to say which. Letting the DB's restrict surface instead would report an
        // internal error for a perfectly ordinary refusal.
        if (!result.ok) return reply.status(409).send({ error: result.reason ?? "target in use" });
        return reply.status(204).send();
      },
    );
  };
}

// Real store backed by the org-scoped Prisma client. Exercised by the gated integration tests.
export function prismaTargetStore(prisma: PrismaClient, organizationId: string): TargetStore {
  const db = scopedPrisma(prisma, organizationId);
  return {
    create: (data) =>
      db.databaseTarget.create({
        data: {
          organizationId,
          name: data.name,
          engine: data.engine,
          host: data.host,
          port: data.port,
          username: data.username,
          tls: data.tls,
          scope: data.scope,
          encryptedCredential: data.encryptedCredential,
        },
      }),
    list: () => db.databaseTarget.findMany(),
    get: (id) => db.databaseTarget.findFirst({ where: { id } }),
    update: async (id, data) => {
      // updateMany, not update: the org-scoped client filters organizationId in the WHERE, so a
      // miss is "not yours or not there" (0 rows) rather than a thrown P2025 on a cross-org id.
      const { count } = await db.databaseTarget.updateMany({ where: { id }, data: definedOnly(data) });
      if (count === 0) return null;
      return db.databaseTarget.findFirst({ where: { id } });
    },
    remove: async (id) => {
      const policies = await db.backupPolicy.count({ where: { targetId: id } });
      // BackupPolicy.target is a required relation with no onDelete, so the database would refuse
      // this anyway — as an opaque constraint violation. Checking first turns it into a reason.
      if (policies > 0) {
        return {
          ok: false,
          reason: `${policies} backup polic${policies === 1 ? "y" : "ies"} still reference this target`,
        };
      }
      await db.databaseTarget.deleteMany({ where: { id } });
      return { ok: true };
    },
  };
}
