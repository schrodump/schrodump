// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { createHash } from "node:crypto";
import { createS3Driver } from "@schrodump/storage/s3";
import { buildApp } from "./app.js";
import { betterAuthResolver, createAuth } from "./auth/auth.js";
import { bootstrap } from "./bootstrap/bootstrap.js";
import { createBootstrapDeps, createSetupDeps } from "./bootstrap/wiring.js";
import { decryptCredential, parseEncryptedCredential } from "./crypto/envelope.js";
import { assertKekFingerprint, kekBuffer } from "./crypto/kek.js";
import { scopedPrisma } from "./data/scope.js";
import { createPrismaClient, type PrismaClient } from "./db.js";
import { loadEnv } from "./env.js";
import { createLogger } from "./observability/pino.js";
import { prismaTargetStore } from "./routes/targets.js";
import { createJobsService, prismaDestinationStore, prismaPolicyStore } from "./routes/wiring.js";

// A stable per-instance auth secret derived from the KEK when none is configured explicitly.
function deriveAuthSecret(kek: Buffer): string {
  return createHash("sha256").update(kek).update("schrodump-better-auth").digest("hex");
}

async function destinationCanary(
  prisma: PrismaClient,
  kek: Buffer,
  organizationId: string,
  destinationId: string,
): Promise<{ ok: boolean; failedOperation: string | null }> {
  const dest = await scopedPrisma(prisma, organizationId).storageDestination.findFirst({
    where: { id: destinationId },
  });
  if (dest === null) return { ok: false, failedOperation: null };
  const secret = decryptCredential(kek, parseEncryptedCredential(dest.encryptedSecretAccessKey));
  const driver = createS3Driver({
    ...(dest.endpoint !== null ? { endpoint: dest.endpoint } : {}),
    region: dest.region,
    bucket: dest.bucket,
    prefix: dest.prefix,
    accessKeyId: dest.accessKeyId,
    secretAccessKey: secret,
    forcePathStyle: dest.forcePathStyle,
  });
  const health = await driver.canary();
  return { ok: health.ok, failedOperation: health.failedOperation };
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
    destinationStore: (organizationId) => prismaDestinationStore(prisma, organizationId),
    destinationCanary: (organizationId, destinationId) =>
      destinationCanary(prisma, kek, organizationId, destinationId),
    policyStore: (organizationId) => prismaPolicyStore(prisma, organizationId),
    jobsService: createJobsService(prisma),
    kek,
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}
