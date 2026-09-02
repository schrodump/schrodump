// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What a failed request tells the caller, and what it tells the log.
//
// Lives on its own so it can be tested as itself. Mounted inline it could only be reached through
// buildApp's dozen dependencies, and a test that reimplemented it would be testing a copy — which
// is how the shape below came to be wrong in the first place without anything noticing.

import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "invalid request" });
    }

    // Fastify classifies its own failures before we see them, and a malformed body is one:
    // an empty or unparseable JSON payload arrives here carrying statusCode 400. Returning 500
    // for it told the caller the server had broken, logged it at error level with a correlation
    // id, and pointed whoever went looking at the wrong side of the connection. Honour the
    // classification that already exists rather than flattening every non-Zod error into 500.
    //
    // The BODY stays generic either way. `error.message` on a 4xx can quote the payload that
    // failed to parse, and request bodies here carry database passwords and S3 secret keys.
    const shape = error as { statusCode?: unknown; code?: unknown };
    const status = typeof shape.statusCode === "number" ? shape.statusCode : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      // warn, not error: a client sent something malformed. Logging it at error level is how a
      // log fills with entries that look like outages and are not.
      request.log.warn(
        { code: typeof shape.code === "string" ? shape.code : undefined, statusCode: status },
        "rejected a malformed request",
      );
      return reply.status(status).send({ error: "invalid request" });
    }

    request.log.error({ err: error }, "request failed");
    return reply.status(500).send({ error: "internal error", correlationId: request.id });
  });
}
