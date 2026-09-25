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
import type { EgressGuard } from "../egress/guard.js";

// `access` is required rather than optional: building a driver decrypts the destination's S3
// secret, which is an art. 37 access, and a caller that cannot say why it needs one should not be
// getting one. See crypto/credential-access.ts.
//
// `egress` is required for the same reason in the other direction. Every S3 use in the product —
// the canary, a backup's upload, a verify's download, retention's delete, the catalog rebuild —
// comes through this one function, so checking the endpoint here is checking it once instead of at
// six call sites, one of which would eventually be added without the check. It refuses BEFORE the
// credential is decrypted: an endpoint this server will not dial is not a reason to unwrap a
// secret, or to write an art. 37 access row for one.
export async function driverForDestination(
  prisma: PrismaClient,
  kek: Buffer,
  organizationId: string,
  destinationId: string,
  access: { audit: CredentialAuditSink; purpose: string; correlationId: string; egress: EgressGuard },
): Promise<{ driver: StorageDriver; prefix: string } | null> {
  const dest = await scopedPrisma(prisma, organizationId).storageDestination.findFirst({
    where: { id: destinationId },
  });
  if (dest === null) return null;
  // No endpoint means AWS S3 itself, which the SDK resolves to a public regional host.
  if (dest.endpoint !== null) await access.egress.assertUrl("endpoint", dest.endpoint);
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
