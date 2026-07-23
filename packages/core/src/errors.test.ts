// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { SchrodumpError } from "./errors.js";

describe("SchrodumpError", () => {
  it("serializes only safe fields in toJSON()", () => {
    const err = new SchrodumpError("backup failed", {
      code: "BACKUP_FAILED",
      correlationId: "corr-123",
      context: { jobId: "job-1", engine: "postgres" },
      sensitive: { connectionString: "postgres://user:s3cret@db/app", password: "s3cret" },
    });

    expect(err.toJSON()).toEqual({
      name: "SchrodumpError",
      code: "BACKUP_FAILED",
      correlationId: "corr-123",
      message: "backup failed",
      context: { jobId: "job-1", engine: "postgres" },
    });

    const serialized = JSON.stringify(err);
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain("connectionString");
    // still carries enough to debug
    expect(serialized).toContain("corr-123");
    expect(serialized).toContain("job-1");
  });

  it("keeps sensitive keys inspectable in-process but out of serialization", () => {
    const err = new SchrodumpError("x", {
      code: "X",
      correlationId: "c",
      sensitive: { password: "p" },
    });
    expect(err.sensitiveKeys).toEqual(["password"]);
    expect(JSON.stringify(err)).not.toContain('"password"');
  });

  it("is a real Error with code, correlationId and empty default context", () => {
    const err = new SchrodumpError("boom", { code: "BOOM", correlationId: "corr-9" });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("BOOM");
    expect(err.correlationId).toBe("corr-9");
    expect(err.context).toEqual({});
  });

  it("preserves cause without serializing it", () => {
    const cause = new Error("driver failed at postgres://user:s3cret@db");
    const err = new SchrodumpError("wrap", { code: "W", correlationId: "c", cause });
    expect(err.cause).toBe(cause);
    expect(JSON.stringify(err)).not.toContain("s3cret");
  });
});
