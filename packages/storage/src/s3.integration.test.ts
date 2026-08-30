// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { PassThrough, Readable } from "node:stream";
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

  it("aborts an in-flight upload on the signal, leaving no object behind", async () => {
    // The reason this matters: the backup pipeline waits on put() before releasing the scratch
    // directory that holds the CLEARTEXT dump. lib-storage's Upload is not signal-aware on its own,
    // so without cancellation an aborted STAGED backup keeps that directory until the multipart
    // upload finishes — on a slow link, well past the shutdown grace.
    const driver = createS3Driver({
      endpoint,
      region: process.env.SCHRODUMP_TEST_S3_REGION ?? "us-east-1",
      bucket: process.env.SCHRODUMP_TEST_S3_BUCKET ?? "schrodump-test",
      prefix: "it",
      accessKeyId: process.env.SCHRODUMP_TEST_S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.SCHRODUMP_TEST_S3_SECRET_KEY ?? "",
      forcePathStyle: true,
    });

    const key = `it/${Date.now()}-aborted.bin`;
    const controller = new AbortController();
    // A body that delivers real bytes and then stalls — the shape of a dump still streaming.
    const body = new PassThrough();
    body.write(Buffer.alloc(1024, 7));

    const put = driver.put(key, body, {
      contentType: "application/octet-stream",
      partSize: 5 * 1024 * 1024,
      metadata: {},
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 250));
    controller.abort();

    await expect(put).rejects.toThrow();
    // Nothing durable was left for retention to never reclaim.
    expect(await driver.head(key)).toBeNull();
  });

  it("refuses to start an upload on an already-aborted signal", async () => {
    const driver = createS3Driver({
      endpoint,
      region: process.env.SCHRODUMP_TEST_S3_REGION ?? "us-east-1",
      bucket: process.env.SCHRODUMP_TEST_S3_BUCKET ?? "schrodump-test",
      prefix: "it",
      accessKeyId: process.env.SCHRODUMP_TEST_S3_ACCESS_KEY ?? "",
      secretAccessKey: process.env.SCHRODUMP_TEST_S3_SECRET_KEY ?? "",
      forcePathStyle: true,
    });
    const key = `it/${Date.now()}-never-started.bin`;
    await expect(
      driver.put(key, Readable.from([Buffer.from("x")]), {
        contentType: "application/octet-stream",
        partSize: 5 * 1024 * 1024,
        metadata: {},
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(await driver.head(key)).toBeNull();
  });
});
