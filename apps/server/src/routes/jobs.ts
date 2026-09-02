// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, contextOf, requireRole, type SessionResolver } from "../auth/rbac.js";

// The API shape of an artifact. Mirrors the DB row but with BigInt sizes narrowed to number, and
// without internal columns (organizationId, updatedAt). Fastify cannot serialize BigInt, so the
// raw row must never reach the response — see toArtifactRecord in wiring.ts.
export interface ArtifactRecord {
  id: string;
  jobId: string;
  destinationId: string;
  state: string;
  bucketKey: string;
  manifestKey: string;
  engine: string;
  // Exposed because the restore gate is execution-mode-based, not engine-based: runRestoreJob
  // refuses a STAGED artifact (mydumper directory, postgres -Fd) of ANY engine. The UI needs the
  // same fact to stop offering a restore the server will refuse. Narrower than the other enum
  // fields on purpose — this one is a control, not a label.
  executionMode: "STREAM" | "STAGED";
  // Whether this archive carries an oplog, which is what makes a FULL_CLUSTER restore replay it
  // (`--oplogReplay`) and land every collection on ONE instant. Recorded at dump time and
  // unrecoverable afterwards: the restore cannot re-derive it without re-probing an origin that may
  // have changed topology or ceased to exist.
  //
  // Exposed because the operator cannot otherwise tell a point-in-time-consistent replica-set
  // archive from an ordinary one — and that is the whole difference between the two on the day it
  // matters. `null` for every engine but mongodb, deliberately: false would assert something about
  // an oplog for a database that has none.
  sourceHasOplog: boolean | null;
  serverVersionNum: number;
  sizeRawBytes: number;
  sizeCompressedBytes: number;
  checksumAlgorithm: string;
  checksum: string;
  compression: string;
  keyIds: string[];
  dependsOn: string[];
  createdAt: Date;
}

// Both lists are capped. A deployment running twenty policies daily, each chaining a verify,
// writes about forty job rows a day — fifteen thousand a year — and the artifact table grows with
// whatever GFS retention keeps. An unbounded list endpoint degrades quietly for a year and then
// stops being usable, which is the worst shape a capacity problem can take.
//
// `total` is sent so the UI can say it is showing the newest N of M rather than implying it has
// shown everything. Silence about truncation is the same class of dishonesty this product exists to
// refuse elsewhere.
export const LIST_PAGE_SIZE = 200;

export interface JobListDTO {
  items: unknown[];
  total: number;
}

export interface ArtifactListDTO {
  items: ArtifactRecord[];
  total: number;
  // Computed across the WHOLE table, not the returned page. See the wiring for why.
  counts: { VERIFIED: number; UNOBSERVED: number; FAILED: number };
}

export interface JobsService {
  listJobs(organizationId: string): Promise<JobListDTO>;
  listArtifacts(organizationId: string): Promise<ArtifactListDTO>;
  // Enqueue a manual BACKUP job for a policy; returns the jobId.
  enqueueBackup(organizationId: string, policyId: string): Promise<string>;
  // Enqueue a VERIFY job for an artifact.
  enqueueVerify(organizationId: string, artifactId: string): Promise<string>;
  // Enqueue a RESTORE job for an artifact; params are persisted on the job's restoreParams.
  enqueueRestore(
    organizationId: string,
    artifactId: string,
    params: { target: string; confirmExistingDatabase: boolean; triggeredByUserId: string },
  ): Promise<string>;
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
