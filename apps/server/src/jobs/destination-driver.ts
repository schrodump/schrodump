// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Destination -> StorageDriver construction, shared by the HTTP layer (canary, catalog rebuild)
// and the worker. Lives on its own so the worker does not import server.ts (which would import the
// worker back in Task 6 — a cycle). It decrypts the destination's S3 secret with the KEK to USE it;
// the plaintext never leaves this call.

import type { PrismaClient } from "@prisma/client";
import type { StorageDriver } from "@schrodump/storage/driver";
import { createS3Driver } from "@schrodump/storage/s3";
import { readCredential, type CredentialAuditSink } from "../crypto/credential-access.js";
import { scopedPrisma } from "../data/scope.js";

// `access` is required rather than optional: building a driver decrypts the destination's S3
// secret, which is an art. 37 access, and a caller that cannot say why it needs one should not be
// getting one. See crypto/credential-access.ts.
export async function driverForDestination(
  prisma: PrismaClient,
  kek: Buffer,
  organizationId: string,
  destinationId: string,
  access: { audit: CredentialAuditSink; purpose: string; correlationId: string },
): Promise<{ driver: StorageDriver; prefix: string } | null> {
  const dest = await scopedPrisma(prisma, organizationId).storageDestination.findFirst({
    where: { id: destinationId },
  });
  if (dest === null) return null;
  const secret = readCredential({ kek, audit: access.audit }, dest.encryptedSecretAccessKey, {
    organizationId,
    resource: "destination",
    resourceId: dest.id,
    purpose: access.purpose,
    correlationId: access.correlationId,
  });
  const driver = createS3Driver({
    ...(dest.endpoint !== null ? { endpoint: dest.endpoint } : {}),
    region: dest.region,
    bucket: dest.bucket,
    prefix: dest.prefix,
    accessKeyId: dest.accessKeyId,
    secretAccessKey: secret,
    forcePathStyle: dest.forcePathStyle,
  });
  return { driver, prefix: dest.prefix };
}
