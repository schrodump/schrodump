// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { authenticate, requireRole, type SessionResolver } from "../auth/rbac.js";

// What this deployment is actually running with. Every value here is decided at boot from the
// environment and, until now, was knowable only by reading the .env on the host — which is the file
// an operator opens the interface to avoid guessing about. Read-only on purpose: these are not
// settings the server may change under itself. A staged dump in flight is sized against the scratch
// budget it started with, and the executor network is a Docker network the running containers are
// already attached to; both are properties of the process, and changing them is a restart.
export interface InstanceConfig {
  version: string;
  // null when SCHRODUMP_SCRATCH_PATH is unset, which is STREAM-only: no staged dump, no verify
  // sandbox, no restore. The single most consequential fact about a deployment's capabilities.
  scratchPath: string | null;
  scratchMaxBytes: number;
  maxConcurrentStaged: number;
  stagedThresholdBytes: number | null;
  executorNetwork: string;
  selfBackupDestinationId: string | null;
  selfBackupIntervalMs: number;
  notifyMinGapMs: number;
  shutdownGraceMs: number;
}

export interface InstanceRoutesDeps {
  resolver: SessionResolver;
  config(): InstanceConfig;
}

// admin, following /self-backups: this describes the host, its filesystem layout and its container
// network, which is an operator-of-the-deployment concern rather than a backup-operator one.
//
// NOTHING SECRET GOES IN THIS RESPONSE. The environment it is assembled from also holds
// SCHRODUMP_KEK and DATABASE_URL; the KEK opens every artifact ever written. The self-backup
// destination is reported as a boolean rather than an id for the same reason the rest of the
// product reports capability rather than credential — the id is already on /destinations for
// anyone entitled to it.
export function instanceRoutes(deps: InstanceRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.get(
      "/instance",
      { preHandler: [authenticate(deps.resolver), requireRole("admin")] },
      async (_request, reply) => {
        const config = deps.config();
        return reply.send({
          version: config.version,
          scratch: {
            configured: config.scratchPath !== null,
            path: config.scratchPath,
            maxBytes: config.scratchMaxBytes,
            maxConcurrentStaged: config.maxConcurrentStaged,
          },
          stagedThresholdBytes: config.stagedThresholdBytes,
          executorNetwork: config.executorNetwork,
          selfBackup: {
            configured: config.selfBackupDestinationId !== null,
            intervalMs: config.selfBackupIntervalMs,
          },
          notifyMinGapMs: config.notifyMinGapMs,
          shutdownGraceMs: config.shutdownGraceMs,
        });
      },
    );
  };
}
