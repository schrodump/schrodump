// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify, { type FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { registerAuthHandler, type Auth } from "./auth/auth.js";
import type { EgressGuard } from "./egress/guard.js";
import type { SessionResolver } from "./auth/rbac.js";
import { registerAuditTrail } from "./observability/audit.js";
import { registerErrorHandler } from "./observability/errors.js";
import { registerHealth } from "./observability/health.js";
import { newCorrelationId } from "./observability/pino.js";
import { catalogRoutes, type CatalogRebuildResultDTO } from "./routes/catalog.js";
import { destinationRoutes, type DestinationStore } from "./routes/destinations.js";
import { encryptionKeyRoutes, type EncryptionKeyRoutesDeps } from "./routes/encryption-keys.js";
import { jobsRoutes, type JobsService } from "./routes/jobs.js";
import {
  notificationRoutes,
  type ChannelStore,
  type TestDeliveryResult,
} from "./routes/notifications.js";
import { policyRoutes, type PolicyStore } from "./routes/policies.js";
import { instanceRoutes, type InstanceConfig } from "./routes/instance.js";
import { memberRoutes, type MemberStore } from "./routes/members.js";
import { auditRoutes, type AuditStore } from "./routes/audit.js";
import { restoreRoutes } from "./routes/restore.js";
import { selfBackupRoutes } from "./routes/self-backups.js";
import { sessionRoutes } from "./routes/session.js";
import { setupRoutes, type SetupDeps } from "./routes/setup.js";
import { targetRoutes, type TargetStore } from "./routes/targets.js";
import { testTargetConnection } from "./probe/test-connection.js";

export interface AppDeps {
  logger: FastifyBaseLogger;
  auth: Auth;
  resolver: SessionResolver;
  setupDeps: SetupDeps;
  targetStore(organizationId: string): TargetStore;
  destinationStore(organizationId: string): DestinationStore;
  destinationCanary(
    organizationId: string,
    destinationId: string,
  ): Promise<{ ok: boolean; failedOperation: string | null }>;
  policyStore(organizationId: string): PolicyStore;
  notificationChannelStore(organizationId: string): ChannelStore;
  // Opens the real connection and delivers, through the same path a scheduled notification takes.
  // Null when the channel is not this organization's.
  notificationTestDelivery(organizationId: string, id: string): Promise<TestDeliveryResult | null>;
  jobsService: JobsService;
  catalogRebuild(organizationId: string, destinationId: string): Promise<CatalogRebuildResultDTO>;
  prisma: PrismaClient;
  encryptionKeys: Pick<EncryptionKeyRoutesDeps, "list" | "existing" | "provision" | "rotate">;
  // Null when self-backup is unconfigured; surfaced by GET /self-backups so the UI can distinguish
  // "not configured" from "configured and never ran".
  selfBackupDestinationId: string | null;
  // What this process booted with, for GET /instance. A function rather than a value so the route
  // reads it at request time and cannot serve a snapshot taken before the environment was parsed.
  instanceConfig(): InstanceConfig;
  memberStore(organizationId: string): MemberStore;
  auditStore(organizationId: string): AuditStore;
  kek: Buffer;
  // SCHRODUMP_TZ: the zone every cron is read in. GET /me tells the UI; the policy routes validate
  // and compute nextRunAt in it.
  timeZone: string;
  // Where this server may open a connection to an address an operator typed. One guard for the four
  // fields that carry one — a target's host, a destination's endpoint, a webhook url, an SMTP host.
  // See egress/guard.ts.
  egress: EgressGuard;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    // request.id IS the correlationId, generated per request and included in every log line.
    genReqId: () => newCorrelationId(),
  });

  // Echo the correlationId on every response; it is propagated down to the runner in the
  // execution prompt.
  app.addHook("onSend", (request, reply, _payload, done) => {
    reply.header("x-correlation-id", request.id);
    done();
  });

  registerErrorHandler(app);

  registerAuditTrail(app, deps.prisma);

  registerHealth(app, deps.prisma);

  registerAuthHandler(app, deps.auth);

  app.register((instance) => {
    setupRoutes(deps.setupDeps)(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    sessionRoutes(deps.resolver, {
      timeZone: deps.timeZone,
      scratchConfigured: () => deps.instanceConfig().scratchPath !== null,
    })(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    restoreRoutes(deps.resolver, deps.jobsService)(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    instanceRoutes({ resolver: deps.resolver, config: deps.instanceConfig })(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    memberRoutes({ resolver: deps.resolver, store: deps.memberStore })(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    auditRoutes({ resolver: deps.resolver, store: deps.auditStore })(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    targetRoutes({
      resolver: deps.resolver,
      kek: deps.kek,
      store: deps.targetStore,
      probe: (target) => testTargetConnection(target, deps.egress),
      egress: deps.egress,
    })(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    destinationRoutes({
      resolver: deps.resolver,
      kek: deps.kek,
      store: deps.destinationStore,
      canary: deps.destinationCanary,
      egress: deps.egress,
    })(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    policyRoutes({
      resolver: deps.resolver,
      store: deps.policyStore,
      timeZone: deps.timeZone,
    })(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    notificationRoutes({
      resolver: deps.resolver,
      kek: deps.kek,
      store: deps.notificationChannelStore,
      testDelivery: deps.notificationTestDelivery,
      egress: deps.egress,
    })(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    jobsRoutes({ resolver: deps.resolver, service: deps.jobsService })(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    catalogRoutes({ resolver: deps.resolver, rebuild: deps.catalogRebuild })(instance);
    encryptionKeyRoutes({ resolver: deps.resolver, ...deps.encryptionKeys })(instance);
    selfBackupRoutes({
      resolver: deps.resolver,
      prisma: deps.prisma,
      configuredDestinationId: deps.selfBackupDestinationId,
    })(instance);
    return Promise.resolve();
  });

  return app;
}
