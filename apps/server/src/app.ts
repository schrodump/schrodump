// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import Fastify, { type FastifyBaseLogger } from "fastify";
import { ZodError } from "zod";
import { registerAuthHandler, type Auth } from "./auth/auth.js";
import type { SessionResolver } from "./auth/rbac.js";
import { newCorrelationId } from "./observability/pino.js";
import { restoreRoutes } from "./routes/restore.js";
import { setupRoutes, type SetupDeps } from "./routes/setup.js";
import { targetRoutes, type TargetStore } from "./routes/targets.js";

export interface AppDeps {
  logger: FastifyBaseLogger;
  auth: Auth;
  resolver: SessionResolver;
  setupDeps: SetupDeps;
  targetStore(organizationId: string): TargetStore;
  kek: Buffer;
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "invalid request" });
    }
    request.log.error({ err: error }, "request failed");
    return reply.status(500).send({ error: "internal error", correlationId: request.id });
  });

  app.get("/health", () => ({ status: "ok" }));

  registerAuthHandler(app, deps.auth);

  app.register((instance) => {
    setupRoutes(deps.setupDeps)(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    restoreRoutes(deps.resolver)(instance);
    return Promise.resolve();
  });
  app.register((instance) => {
    targetRoutes({ resolver: deps.resolver, kek: deps.kek, store: deps.targetStore })(instance);
    return Promise.resolve();
  });

  return app;
}
