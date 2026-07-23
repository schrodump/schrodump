// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";
import { encryptCredential, type EncryptedCredential } from "../crypto/envelope.js";

const CreateDestinationSchema = z.object({
  name: z.string().min(1),
  endpoint: z.url().optional(),
  region: z.string().min(1),
  bucket: z.string().min(1),
  prefix: z.string(),
  accessKeyId: z.string().min(1),
  // Write-only: encrypted into encryptedSecretAccessKey, never echoed.
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().default(false),
  sealMode: z.enum(["operational", "sealed"]).default("operational"),
});

export interface CreateDestinationData {
  name: string;
  endpoint?: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  encryptedSecretAccessKey: EncryptedCredential;
  forcePathStyle: boolean;
  sealMode: "operational" | "sealed";
}

export interface DestinationRecord {
  id: string;
  name: string;
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  // Present in the store, NEVER returned.
  encryptedSecretAccessKey: unknown;
  forcePathStyle: boolean;
  sealMode: string;
}

export interface DestinationStore {
  create(data: CreateDestinationData): Promise<DestinationRecord>;
  list(): Promise<DestinationRecord[]>;
  get(id: string): Promise<DestinationRecord | null>;
}

function toPublic(destination: DestinationRecord) {
  return {
    id: destination.id,
    name: destination.name,
    endpoint: destination.endpoint,
    region: destination.region,
    bucket: destination.bucket,
    prefix: destination.prefix,
    accessKeyId: destination.accessKeyId,
    forcePathStyle: destination.forcePathStyle,
    sealMode: destination.sealMode,
  };
}

export interface DestinationRoutesDeps {
  resolver: SessionResolver;
  kek: Buffer;
  store(organizationId: string): DestinationStore;
  // Runs the destination canary (PUT/GET/DELETE health check) for a given destination.
  canary(organizationId: string, destinationId: string): Promise<{ ok: boolean; failedOperation: string | null }>;
}

export function destinationRoutes(deps: DestinationRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.post(
      "/destinations",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const parsed = CreateDestinationSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid destination" });
        const created = await deps.store(contextOf(request).organizationId).create({
          name: parsed.data.name,
          ...(parsed.data.endpoint !== undefined ? { endpoint: parsed.data.endpoint } : {}),
          region: parsed.data.region,
          bucket: parsed.data.bucket,
          prefix: parsed.data.prefix,
          accessKeyId: parsed.data.accessKeyId,
          encryptedSecretAccessKey: encryptCredential(deps.kek, parsed.data.secretAccessKey),
          forcePathStyle: parsed.data.forcePathStyle,
          sealMode: parsed.data.sealMode,
        });
        return reply.status(201).send(toPublic(created));
      },
    );

    app.get(
      "/destinations",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => {
        const list = await deps.store(contextOf(request).organizationId).list();
        return reply.send(list.map(toPublic));
      },
    );

    app.post(
      "/destinations/:id/canary",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const health = await deps.canary(contextOf(request).organizationId, params.data.id);
        return reply.send(health);
      },
    );
  };
}
