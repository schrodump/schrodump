// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";
import { cronProblem, nextWindow } from "../scheduler/cron.js";
import { badRequest } from "./errors.js";

// A cron is read by the parser the scheduler runs, on the instance's clock, before it is stored.
// It used to be `z.string().min(1)`: "0 0 30 2 *" was accepted with a 201 and then threw inside
// every scheduler tick. The refusal names the field and says why, in cron.ts's own sentence.
function cronField(timeZone: string) {
  return z
    .string()
    .min(1)
    .superRefine((cron, ctx) => {
      const problem = cronProblem(cron, timeZone);
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
    });
}

// verifyLevel defaults to FULL_RESTORE: the product's claim is that a backup is not trusted until a
// restore has verified it, and the default was CHECKSUM — a hash of the bytes, which the roadmap
// records would have marked the 876-byte and the extension-less artifacts VERIFIED. A green now means
// a restore reproduced the database unless someone chose less, and the UI says which beside the badge.
// Where a full restore cannot run (a sealed destination, an unscoped replica-set dump) the verify
// downgrades to CHECKSUM and records verifiedDegraded; without scratch it cannot run at all and ends
// INCONCLUSIVE, leaving the artifact amber — the honest answer, never a false green. Turning verify
// off (NONE) is an explicit choice the UI must warn about.
function createPolicySchema(timeZone: string) {
  return z.object({
    name: z.string().min(1),
    targetId: z.string().min(1),
    destinationId: z.string().min(1),
    cron: cronField(timeZone),
    keepLast: z.number().int().min(0).default(0),
    keepDaily: z.number().int().min(0).default(0),
    keepWeekly: z.number().int().min(0).default(0),
    keepMonthly: z.number().int().min(0).default(0),
    keepYearly: z.number().int().min(0).default(0),
    minAgeBeforeDeleteMs: z.number().int().min(0).default(0),
    verifyLevel: z.enum(["NONE", "CHECKSUM", "FULL_RESTORE"]).default("FULL_RESTORE"),
    executionMode: z.enum(["STREAM", "STAGED"]).default("STREAM"),
    parallelism: z.number().int().min(1).default(1),
    compression: z.enum(["none", "zstd", "gzip"]).default("zstd"),
    enabled: z.boolean().default(true),
  });
}

export type CreatePolicyData = z.infer<ReturnType<typeof createPolicySchema>>;

// Editable fields only, all optional, `.strict()` so a withheld field is a 400 rather than a silent
// drop. `targetId` and `destinationId` are absent on purpose.
//
// Retention reasons per policy: it prunes the artifacts produced by THIS policy's backups, on THIS
// policy's destination. Repointing the target would fold two different databases' artifacts into
// one GFS chain; repointing the destination would leave every artifact already written to the old
// one outside retention forever — never pruned, never attributable, and nothing about the policy
// would look wrong. A policy that backs up something else is a new policy.
function updatePolicySchema(timeZone: string) {
  return z
    .object({
      name: z.string().min(1),
      cron: cronField(timeZone),
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
}

export type UpdatePolicyData = z.infer<ReturnType<typeof updatePolicySchema>>;

export interface RemovePolicyResult {
  ok: boolean;
  reason?: string;
}

export interface PolicyRecord extends CreatePolicyData {
  id: string;
}

// What the API answers with: the stored policy plus when the scheduler will next dispatch it.
// Computed here, on the instance's clock, because the browser cannot: it runs on the viewer's, and
// reading "0 2 * * *" there is how a São Paulo operator was told 02:00 for a job that ran at 23:00.
// null when the policy is disabled (nothing will run) or when its cron cannot be read — one stored
// before the route validated it, which the scheduler now skips on every tick.
export interface PolicyView extends PolicyRecord {
  nextRunAt: string | null;
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
  // SCHRODUMP_TZ: the zone the scheduler reads every cron in. The validation and nextRunAt use it
  // so neither can describe a different schedule from the one that runs.
  timeZone: string;
  now?: () => Date;
}

export function policyRoutes(deps: PolicyRoutesDeps) {
  const CreatePolicySchema = createPolicySchema(deps.timeZone);
  const UpdatePolicySchema = updatePolicySchema(deps.timeZone);
  const now = deps.now ?? (() => new Date());

  const view = (policy: PolicyRecord): PolicyView => {
    let nextRunAt: string | null = null;
    if (policy.enabled) {
      try {
        nextRunAt = nextWindow(policy.cron, now(), deps.timeZone).toISOString();
      } catch {
        // An unreadable stored cron: the list still answers, and the row says why it will not run.
      }
    }
    return { ...policy, nextRunAt };
  };

  return (app: FastifyInstance): void => {
    app.post(
      "/policies",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const parsed = CreatePolicySchema.safeParse(request.body);
        if (!parsed.success) return badRequest(reply, "invalid policy", parsed.error);
        const created = await deps.store(contextOf(request).organizationId).create(parsed.data);
        return reply.status(201).send(view(created));
      },
    );

    app.get(
      "/policies",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => {
        const policies = await deps.store(contextOf(request).organizationId).list();
        return reply.send(policies.map(view));
      },
    );

    app.get(
      "/policies/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return badRequest(reply, "invalid id", params.error);
        const policy = await deps.store(contextOf(request).organizationId).get(params.data.id);
        if (policy === null) return reply.status(404).send({ error: "not found" });
        return reply.send(view(policy));
      },
    );

    app.patch(
      "/policies/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return badRequest(reply, "invalid id", params.error);
        const parsed = UpdatePolicySchema.safeParse(request.body);
        if (!parsed.success) return badRequest(reply, "invalid policy update", parsed.error);
        if (Object.keys(parsed.data).length === 0) {
          return reply.status(400).send({ error: "no fields to update" });
        }
        const updated = await deps
          .store(contextOf(request).organizationId)
          .update(params.data.id, parsed.data);
        if (updated === null) return reply.status(404).send({ error: "not found" });
        return reply.send(view(updated));
      },
    );

    app.delete(
      "/policies/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
        if (!params.success) return badRequest(reply, "invalid id", params.error);
        const result = await deps.store(contextOf(request).organizationId).remove(params.data.id);
        if (!result.ok) return reply.status(409).send({ error: result.reason ?? "policy in use" });
        return reply.status(204).send();
      },
    );
  };
}
