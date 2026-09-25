// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptCredential } from "../crypto/envelope.js";
import { allowAnyEgress, refuseAnyEgress, REFUSAL } from "../egress/guard.fixture.js";
import { driverForDestination } from "./destination-driver.js";

const KEK = Buffer.alloc(32, 7);

// Enough of a client for scopedPrisma's extension to wrap and for this one query to answer. The
// same shape routes/wiring.test.ts uses, for the same reason: the S3 endpoint check has to be
// provable without a database or a bucket.
function fakePrisma(row: Record<string, unknown> | null) {
  interface Op {
    model: string;
    operation: string;
    args: Record<string, unknown>;
    query: (a: Record<string, unknown>) => Promise<unknown>;
  }
  let wrap: ((op: Op) => Promise<unknown>) | null = null;
  const base = {
    storageDestination: {
      findFirst: (args: Record<string, unknown>) => {
        const run = () => Promise.resolve(row);
        return wrap === null
          ? run()
          : wrap({ model: "StorageDestination", operation: "findFirst", args, query: run });
      },
    },
    $extends: (ext: { query: { $allModels: { $allOperations: (op: Op) => Promise<unknown> } } }) => {
      wrap = ext.query.$allModels.$allOperations;
      return base;
    },
  };
  return base as unknown as PrismaClient;
}

function destination(endpoint: string | null) {
  return {
    id: "d1",
    organizationId: "org-1",
    endpoint,
    region: "us-east-1",
    bucket: "backups",
    prefix: "s",
    accessKeyId: "AKIAEXAMPLE",
    encryptedSecretAccessKey: encryptCredential(KEK, "s3cret-access-key"),
    forcePathStyle: true,
  };
}

describe("driverForDestination and the egress guard", () => {
  it("refuses a denied endpoint, and does so BEFORE the S3 secret is decrypted", async () => {
    // Every S3 use in the product comes through here — the canary, a backup's upload, a verify's
    // download, retention's delete, the catalog rebuild — so this is the one place the endpoint has
    // to be judged. It is judged before readCredential, because an endpoint this server will not
    // dial is not a reason to unwrap a secret or to write an art. 37 access row for one.
    const record = vi.fn();
    await expect(
      driverForDestination(fakePrisma(destination("http://docker-proxy:2375")), KEK, "org-1", "d1", {
        audit: { record },
        egress: refuseAnyEgress,
        purpose: "canary: exercise put/get/delete against the destination",
        correlationId: "canary:d1",
      }),
    ).rejects.toMatchObject({ name: "EgressRefusedError", field: "endpoint", message: REFUSAL });
    expect(record).not.toHaveBeenCalled();
  });

  it("builds the driver for an allowed endpoint", async () => {
    // The ordinary self-hosted shape: MinIO on the operator's own network, which the default policy
    // permits. The guard must not be a wall in front of the product's normal case.
    const resolved = await driverForDestination(
      fakePrisma(destination("http://192.168.1.10:9000")),
      KEK,
      "org-1",
      "d1",
      {
        audit: { record: () => undefined },
        egress: allowAnyEgress,
        purpose: "canary: exercise put/get/delete against the destination",
        correlationId: "canary:d1",
      },
    );
    expect(resolved?.prefix).toBe("s");
  });

  it("asks nothing of the guard when no endpoint is configured", async () => {
    // No endpoint means AWS S3 itself, which the SDK resolves to a public regional host. There is
    // no operator-supplied address to check, and refusing on a null would break every AWS
    // destination.
    const checkUrl = vi.fn();
    const resolved = await driverForDestination(fakePrisma(destination(null)), KEK, "org-1", "d1", {
      audit: { record: () => undefined },
      egress: { ...refuseAnyEgress, assertUrl: checkUrl },
      purpose: "canary: exercise put/get/delete against the destination",
      correlationId: "canary:d1",
    });
    expect(checkUrl).not.toHaveBeenCalled();
    expect(resolved).not.toBeNull();
  });
});
