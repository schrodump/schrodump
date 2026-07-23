// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createS3Driver } from "./s3.js";

// Opt-in integration test against a real S3-compatible endpoint (e.g. MinIO). It is skipped
// unless SCHRODUMP_TEST_S3_ENDPOINT is set, so a CI runner without Docker is never affected.
//
// Point it at a MinIO container, e.g.:
//   docker run -p 9000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio123 \
//     minio/minio server /data
// then export SCHRODUMP_TEST_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _BUCKET.

const endpoint = process.env.SCHRODUMP_TEST_S3_ENDPOINT;
const enabled = endpoint !== undefined && endpoint.length > 0;

describe.skipIf(!enabled)("s3 integration (S3-compatible endpoint)", () => {
  it("round-trips put / head / delete and passes the canary", async () => {
    const driver = createS3Driver({
      endpoint,
      region: process.env.SCHRODUMP_TEST_S3_REGION ?? "us-east-1",
      bucket: process.env.SCHRODUMP_TEST_S3_BUCKET ?? "schrodump-test",
      prefix: "it",
      accessKeyId: process.env.SCHRODUMP_TEST_S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.SCHRODUMP_TEST_S3_SECRET_KEY ?? "",
      forcePathStyle: true,
    });

    const key = `it/${Date.now()}-object.bin`;
    const payload = Buffer.from("hello schrodump");

    const putResult = await driver.put(key, Readable.from([payload]), {
      contentType: "application/octet-stream",
      partSize: 5 * 1024 * 1024,
      metadata: {},
    });
    expect(putResult.sizeBytes).toBe(payload.length);

    const meta = await driver.head(key);
    expect(meta?.sizeBytes).toBe(payload.length);

    const health = await driver.canary();
    expect(health.ok).toBe(true);

    await driver.delete([key]);
    expect(await driver.head(key)).toBeNull();
  });
});
