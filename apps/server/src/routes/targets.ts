// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";
import { encryptCredential, type EncryptedCredential } from "../crypto/envelope.js";
import { scopedPrisma } from "../data/scope.js";

const EngineSchema = z.enum(["postgres", "mysql", "mariadb", "mongodb"]);
const ScopeSchema = z.object({
  databases: z.array(z.string()),
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

type EngineName = z.infer<typeof EngineSchema>;

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
}

export interface TargetStore {
  create(data: CreateTargetData): Promise<TargetRecord>;
  list(): Promise<TargetRecord[]>;
  get(id: string): Promise<TargetRecord | null>;
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
  };
}

export interface TargetRoutesDeps {
  resolver: SessionResolver;
  kek: Buffer;
  store(organizationId: string): TargetStore;
}

export function targetRoutes(deps: TargetRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.post(
      "/targets",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const parsed = CreateTargetSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid target" });
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
  };
}
