// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { JobKind, JobState } from "@prisma/client";
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
  // What was backed up, resolved by the server through the job that wrote the artifact: the policy
  // it ran under and that policy's target. Both null when the policy was deleted — an absence the
  // UI renders as absence, never as a placeholder that reads like a name. Without these the row led
  // with the bucket key, a storage path, because nothing else on it said what the artifact was.
  targetName: string | null;
  policyName: string | null;
  state: string;
  // How the artifact reached that state: the verify level that actually ran, and whether it was a
  // downgrade from what the policy asked. Exposed because `state` alone cannot separate a green
  // proven by a real restore from one only checksum-verified — and a downgraded checksum (an
  // unscoped replica-set dump v1 cannot restore-verify, a sealed destination) is a checksum green
  // the operator never asked for. `null`/`false` for artifacts verified before this was tracked, and
  // for ones no verify has reached a verdict on yet.
  verifiedLevel: string | null;
  verifiedDegraded: boolean;
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
  // Whether this artifact's dump script carries more than one database. Exposed for the same reason
  // as executionMode: the server refuses a sub-cluster restore of one (a mysqldump script replays
  // its own USE statements and no flag confines it), and the UI needs the fact to stop offering a
  // restore that is certain to be refused. `null` is "never recorded", NOT "no" — for these engines
  // only a recorded false clears the gate. `null` for every engine whose restore is not a replayed
  // script, deliberately: false would assert something about a script those artifacts do not have.
  dumpIsMultiDatabase: boolean | null;
  serverVersionNum: number;
  sizeRawBytes: number;
  sizeCompressedBytes: number;
  checksumAlgorithm: string;
  checksum: string;
  compression: string;
  keyIds: string[];
  dependsOn: string[];
  createdAt: Date;
  // Last time the row changed — in practice the last verify that reached a verdict (it writes the
  // state and level). Exposed so the UI can say "verified 3 days ago": freshness is the question
  // the catalog is really asked, and it cannot be derived from createdAt alone.
  updatedAt: Date;
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
  // Over the WHOLE table, like the artifact counts. The ledger's header says how many runs are in
  // flight, how many are waiting, and how many broke or could not run today; a capped page can only
  // say what happened to the newest two hundred rows, and a filter chip that counted the page would
  // shrink the moment the list got trimmed.
  counts: { byState: Record<JobState, number>; byKind: Record<JobKind, number> };
  stats: {
    // The scheduled time of the PENDING job that has waited longest. With "now" it is how far
    // behind the workers are — the first signal a deployment gives when it is falling behind.
    oldestPendingScheduledAt: Date | null;
    // Finished in the last 24 hours. FAILED is a broken process; INCONCLUSIVE is a verify that
    // never got to look, whose artifact is unchanged and still UNOBSERVED.
    failedLast24h: number;
    inconclusiveLast24h: number;
  };
}

export interface ArtifactListDTO {
  items: ArtifactRecord[];
  total: number;
  // Computed across the WHOLE table, not the returned page. See the wiring for why.
  counts: { VERIFIED: number; UNOBSERVED: number; FAILED: number };
  // How the VERIFIED ones were verified: a restore that reproduced the database, or a hash that
  // matched the manifest. The two greens are not the same claim, and the header says which.
  verifiedByLevel: { FULL_RESTORE: number; CHECKSUM: number };
  // Distinct destinations holding at least one artifact.
  destinations: number;
  // The UNOBSERVED artifact that has waited longest for a verdict — the oldest open question,
  // named by its target and execution mode so the number has a subject.
  oldestUnobserved: {
    id: string;
    createdAt: Date;
    targetName: string | null;
    executionMode: string;
  } | null;
}

// The outcome of a manual delete. `verified_needs_ack` is not a failure to hide — it is the
// product refusing to throw away a proven-good backup on a single click, and the operator has to
// say they mean it. `not_found` covers both a missing id and one in another organization (the
// scoped query cannot tell them apart, and must not).
export type DeleteArtifactResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "verified_needs_ack" };

export interface JobsService {
  listJobs(organizationId: string): Promise<JobListDTO>;
  listArtifacts(organizationId: string): Promise<ArtifactListDTO>;
  // Permanently delete an artifact: its object, its manifest sidecar (and the postgres globals
  // sibling), then the catalog row. A VERIFIED artifact is refused unless acknowledgeVerified is
  // set — deleting a backup a restore has proven good is a deliberate act, not a stray click.
  deleteArtifact(
    organizationId: string,
    artifactId: string,
    opts: { acknowledgeVerified: boolean },
  ): Promise<DeleteArtifactResult>;
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
  // Stores what the probe found, so the deployment can be asked later whether this target was ever
  // proven reachable. The CODE is stored, never the driver's message — see testConnection above,
  // and the column it would otherwise leak the credential into.
  recordProbe(
    organizationId: string,
    targetId: string,
    result: { ok: boolean; serverVersionNum: number | null; failure: string | null },
  ): Promise<void>;
}

export interface JobsRoutesDeps {
  resolver: SessionResolver;
  service: JobsService;
}

const IdParams = z.object({ id: z.string().min(1) });
// The acknowledgement that lets a VERIFIED artifact be deleted. Defaults false so the safe path is
// the default: a caller that sends nothing cannot delete a proven-good backup by omission.
const DeleteArtifactBody = z.object({ acknowledgeVerified: z.boolean().default(false) });

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

    // operator+, and the deletion is recorded automatically as `artifact.delete` by the audit hook.
    app.delete(
      "/artifacts/:id",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = IdParams.safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const body = DeleteArtifactBody.safeParse(request.body ?? {});
        if (!body.success) return reply.status(400).send({ error: "invalid request" });
        const result = await deps.service.deleteArtifact(
          contextOf(request).organizationId,
          params.data.id,
          { acknowledgeVerified: body.data.acknowledgeVerified },
        );
        if (!result.ok) {
          if (result.reason === "not_found") {
            return reply.status(404).send({ error: "no such artifact" });
          }
          // The refusal the operator has to answer, not an error to bury: a VERIFIED artifact is a
          // restore-proven backup. The code lets the UI ask for the acknowledgement specifically.
          return reply
            .status(409)
            .send({ error: "a verified artifact needs acknowledgement to delete", code: "VERIFIED_NEEDS_ACK" });
        }
        return reply.status(204).send();
      },
    );

    app.post(
      "/targets/:id/test-connection",
      { preHandler: [authenticate(deps.resolver), requireRole("operator")] },
      async (request, reply) => {
        const params = IdParams.safeParse(request.params);
        if (!params.success) return reply.status(400).send({ error: "invalid id" });
        const organizationId = contextOf(request).organizationId;
        const result = await deps.service.testConnection(organizationId, params.data.id);
        // Recorded on a refusal as well: "probed and refused" and "never probed" are different
        // answers, and the setup checklist only stops asking for one of them.
        await deps.service.recordProbe(organizationId, params.data.id, result);
        return reply.send(result);
      },
    );
  };
}
