// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { createHash } from "node:crypto";
import { buildApp } from "./app.js";
import { betterAuthResolver, createAuth } from "./auth/auth.js";
import { bootstrap } from "./bootstrap/bootstrap.js";
import { createBootstrapDeps, createSetupDeps } from "./bootstrap/wiring.js";
import { assertKekFingerprint, kekBuffer } from "./crypto/kek.js";
import { createPrismaClient } from "./db.js";
import { loadEnv } from "./env.js";
import { createLogger } from "./observability/pino.js";
import { prismaTargetStore } from "./routes/targets.js";

// A stable per-instance auth secret derived from the KEK when none is configured explicitly.
function deriveAuthSecret(kek: Buffer): string {
  return createHash("sha256").update(kek).update("schrodump-better-auth").digest("hex");
}

export async function main(): Promise<void> {
  const env = loadEnv();
  const kek = kekBuffer(env.SCHRODUMP_KEK);
  const logger = createLogger(env.LOG_LEVEL);
  const prisma = createPrismaClient();

  // Fail the boot if the KEK differs from the one this instance was initialized with.
  await assertKekFingerprint(prisma, kek);

  const auth = createAuth(prisma, {
    secret: env.BETTER_AUTH_SECRET ?? deriveAuthSecret(kek),
    baseURL: env.SCHRODUMP_URL,
  });

  await bootstrap(createBootstrapDeps(prisma, auth, env, logger), env);

  const app = buildApp({
    logger,
    auth,
    resolver: betterAuthResolver(auth, prisma),
    setupDeps: createSetupDeps(prisma, auth),
    targetStore: (organizationId) => prismaTargetStore(prisma, organizationId),
    kek,
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}
