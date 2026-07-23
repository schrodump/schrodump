// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";

export interface JobsService {
  listJobs(organizationId: string): Promise<unknown[]>;
  listArtifacts(organizationId: string): Promise<unknown[]>;
  // Enqueue a manual BACKUP job for a policy; returns the jobId.
  enqueueBackup(organizationId: string, policyId: string): Promise<string>;
  // Enqueue a VERIFY job for an artifact.
  enqueueVerify(organizationId: string, artifactId: string): Promise<string>;
  // Probe the target to test connectivity. Returns a failure CODE, never a driver message:
  // driver errors embed the credential they failed with.
  testConnection(
    organizationId: string,
    targetId: string,
  ): Promise<{
    ok: boolean;
    serverVersionNum: number | null;
    failure: string | null;
    driverCode: string | null;
  }>;
}

export interface JobsRoutesDeps {
  resolver: SessionResolver;
  service: JobsService;
}

const IdParams = z.object({ id: z.string().min(1) });

export function jobsRoutes(deps: JobsRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.get(
      "/jobs",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) => reply.send(await deps.service.listJobs(contextOf(request).organizationId)),
    );

    app.get(
      "/artifacts",
      { preHandler: [authenticate(deps.resolver), requireRole("viewer")] },
      async (request, reply) =>
        reply.send(await deps.service.listArtifacts(contextOf(request).organizationId)),
    );

    app.post(
      "/policies/:id/backup",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = IdParams.safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const jobId = await deps.service.enqueueBackup(contextOf(request).organizationId, params.data.id);
        return reply.status(202).send({ jobId });
      },
    );

    app.post(
      "/artifacts/:id/verify",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = IdParams.safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const jobId = await deps.service.enqueueVerify(contextOf(request).organizationId, params.data.id);
        return reply.status(202).send({ jobId });
      },
    );

    app.post(
      "/targets/:id/test-connection",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = IdParams.safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const result = await deps.service.testConnection(contextOf(request).organizationId, params.data.id);
        return reply.send(result);
      },
    );
  };
}
