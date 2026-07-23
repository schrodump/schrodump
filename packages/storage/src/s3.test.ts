// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { S3DestinationConfigSchema, createS3Driver, redactConfig } from "./s3.js";

const RAW = {
  region: "us-east-1",
  bucket: "backups",
  prefix: "schrodump",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "super-secret-value",
  forcePathStyle: true,
};

describe("S3DestinationConfigSchema", () => {
  it("accepts a valid config and applies the 64 MiB partSize default", () => {
    const parsed = S3DestinationConfigSchema.parse(RAW);
    expect(parsed.partSize).toBe(64 * 1024 * 1024);
    expect(parsed.forcePathStyle).toBe(true);
  });

  it("rejects a partSize below the 5 MiB multipart minimum", () => {
    expect(S3DestinationConfigSchema.safeParse({ ...RAW, partSize: 1024 }).success).toBe(false);
  });

  it("rejects a missing required credential", () => {
    const result = S3DestinationConfigSchema.safeParse({
      region: "us-east-1",
      bucket: "backups",
      prefix: "schrodump",
      accessKeyId: "AKIAEXAMPLE",
      forcePathStyle: true,
      // secretAccessKey omitted
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-URL endpoint", () => {
    expect(S3DestinationConfigSchema.safeParse({ ...RAW, endpoint: "not a url" }).success).toBe(
      false,
    );
  });
});

describe("redactConfig", () => {
  it("never exposes credentials", () => {
    const safe = redactConfig(S3DestinationConfigSchema.parse(RAW));
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("AKIAEXAMPLE");
    expect(safe.bucket).toBe("backups");
    expect(safe.endpoint).toBeNull();
  });
});

describe("createS3Driver", () => {
  it("builds a driver exposing the StorageDriver surface for valid config", () => {
    const driver = createS3Driver(RAW);
    for (const method of ["put", "get", "head", "delete", "list", "canary"] as const) {
      expect(typeof driver[method]).toBe("function");
    }
  });

  it("validates at the edge and throws on invalid config", () => {
    expect(() => createS3Driver({ region: "us-east-1" })).toThrow();
  });
});
