// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashSetupToken, isSetupTokenUsable, type SetupTokenRecord } from "../bootstrap/setup-token.js";

export interface SetupDeps {
  userExists(): Promise<boolean>;
  findSetupToken(tokenHash: string): Promise<SetupTokenRecord | null>;
  consumeAndCreateAdmin(input: { tokenHash: string; email: string; password: string }): Promise<void>;
  now(): Date;
}

const BodySchema = z.object({
  token: z.string().min(1),
  email: z.email(),
  password: z.string().min(8),
});

// There is no web recovery mode: /setup 404s once any user exists. Recovery is CLI only
// (`schrodump admin reset`), run via `docker compose exec`, which already proves host access.
export function setupRoutes(deps: SetupDeps) {
  return (app: FastifyInstance): void => {
    app.get("/setup", async (_request, reply) => {
      if (await deps.userExists()) {
        return reply.status(404).send({ error: "not found" });
      }
      return reply.send({ setupRequired: true });
    });

    app.post("/setup", async (request, reply) => {
      if (await deps.userExists()) {
        return reply.status(404).send({ error: "not found" });
      }
      const parsed = BodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid setup payload" });
      }
      const tokenHash = hashSetupToken(parsed.data.token);
      const record = await deps.findSetupToken(tokenHash);
      if (!isSetupTokenUsable(record, deps.now())) {
        return reply.status(401).send({ error: "invalid or expired setup token" });
      }
      await deps.consumeAndCreateAdmin({
        tokenHash,
        email: parsed.data.email,
        password: parsed.data.password,
      });
      return reply.status(201).send({ ok: true });
    });
  };
}
