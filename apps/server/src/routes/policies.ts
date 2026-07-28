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

// Editable fields only, all optional, `.strict()` so a withheld field is a 400 rather than a silent
// drop. `targetId` and `destinationId` are absent on purpose.
//
// Retention reasons per policy: it prunes the artifacts produced by THIS policy's backups, on THIS
// policy's destination. Repointing the target would fold two different databases' artifacts into
// one GFS chain; repointing the destination would leave every artifact already written to the old
// one outside retention forever — never pruned, never attributable, and nothing about the policy
// would look wrong. A policy that backs up something else is a new policy.
const UpdatePolicySchema = z
  .object({
    name: z.string().min(1),
    cron: z.string().min(1),
    keepLast: z.number().int().min(0),
    keepDaily: z.number().int().min(0),
    keepWeekly: z.number().int().min(0),
    keepMonthly: z.number().int().min(0),
    keepYearly: z.number().int().min(0),
    minAgeBeforeDeleteMs: z.number().int().min(0),
    verifyLevel: z.enum(["NONE", "CHECKSUM", "FULL_RESTORE"]),
    executionMode: z.enum(["STREAM", "STAGED"]),
    parallelism: z.number().int().min(1),
    compression: z.enum(["none", "zstd", "gzip"]),
    enabled: z.boolean(),
  })
  .partial()
  .strict();

export type UpdatePolicyData = z.infer<typeof UpdatePolicySchema>;

export interface RemovePolicyResult {
  ok: boolean;
  reason?: string;
}

export interface PolicyRecord extends CreatePolicyData {
  id: string;
}

export interface PolicyStore {
  create(data: CreatePolicyData): Promise<PolicyRecord>;
  list(): Promise<PolicyRecord[]>;
  get(id: string): Promise<PolicyRecord | null>;
  // null when no row with that id exists in the caller's organization.
  update(id: string, data: UpdatePolicyData): Promise<PolicyRecord | null>;
  remove(id: string): Promise<RemovePolicyResult>;
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

    app.patch(
      "/policies/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const parsed = UpdatePolicySchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "invalid policy update" });
        if (Object.keys(parsed.data).length === 0) {
          return reply.status(400).send({ error: "no fields to update" });
        }
        const updated = await deps
          .store(contextOf(request).organizationId)
          .update(params.data.id, parsed.data);
        if (updated === null) return reply.status(404).send({ error: "not found" });
        return reply.send(updated);
      },
    );

    app.delete(
      "/policies/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const result = await deps.store(contextOf(request).organizationId).remove(params.data.id);
        if (!result.ok) return reply.status(409).send({ error: result.reason ?? "policy in use" });
        return reply.status(204).send();
      },
    );
  };
}
