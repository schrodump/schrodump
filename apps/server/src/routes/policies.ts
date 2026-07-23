// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";

// verifyLevel default is CHECKSUM — verify is ON by default; turning it off (NONE) is an explicit
// choice the UI must warn about.
const CreatePolicySchema = z.object({
  name: z.string().min(1),
  targetId: z.string().min(1),
  destinationId: z.string().min(1),
  cron: z.string().min(1),
  keepLast: z.number().int().min(0).default(0),
  keepDaily: z.number().int().min(0).default(0),
  keepWeekly: z.number().int().min(0).default(0),
  keepMonthly: z.number().int().min(0).default(0),
  keepYearly: z.number().int().min(0).default(0),
  minAgeBeforeDeleteMs: z.number().int().min(0).default(0),
  verifyLevel: z.enum(["NONE", "CHECKSUM", "FULL_RESTORE"]).default("CHECKSUM"),
  executionMode: z.enum(["STREAM", "STAGED"]).default("STREAM"),
  parallelism: z.number().int().min(1).default(1),
  compression: z.enum(["none", "zstd", "gzip"]).default("zstd"),
  enabled: z.boolean().default(true),
});

export type CreatePolicyData = z.infer<typeof CreatePolicySchema>;

export interface PolicyRecord extends CreatePolicyData {
  id: string;
}

export interface PolicyStore {
  create(data: CreatePolicyData): Promise<PolicyRecord>;
  list(): Promise<PolicyRecord[]>;
  get(id: string): Promise<PolicyRecord | null>;
}

export interface PolicyRoutesDeps {
  resolver: SessionResolver;
  store(organizationId: string): PolicyStore;
}

export function policyRoutes(deps: PolicyRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.post(
      "/policies",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const parsed = CreatePolicySchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid policy" });
        const created = await deps.store(contextOf(request).organizationId).create(parsed.data);
        return reply.status(201).send(created);
      },
    );

    app.get(
      "/policies",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => {
        return reply.send(await deps.store(contextOf(request).organizationId).list());
      },
    );

    app.get(
      "/policies/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const policy = await deps.store(contextOf(request).organizationId).get(params.data.id);
        if (policy === null) return reply.status(404).send({ error: "not found" });
        return reply.send(policy);
      },
    );
  };
}
