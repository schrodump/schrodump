// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import type { ProbeResult as EngineProbeResult } from "@schrodump/engines/probe/types";
import { resolveVerifyPlan, sanitizeReason, toBackupProbe } from "./worker-wiring.js";

describe("resolveVerifyPlan", () => {
  it("keeps FULL_RESTORE for postgres with no downgrade", () => {
    expect(resolveVerifyPlan("FULL_RESTORE", "postgres")).toEqual({
      effectiveLevel: "FULL_RESTORE",
      downgradeReason: null,
    });
  });

  it("downgrades FULL_RESTORE to CHECKSUM for non-postgres engines with a PostgreSQL-only reason", () => {
    for (const engine of ["mysql", "mariadb", "mongodb"] as const) {
      const plan = resolveVerifyPlan("FULL_RESTORE", engine);
      expect(plan.effectiveLevel).toBe("CHECKSUM");
      expect(plan.downgradeReason).toMatch(/PostgreSQL only/i);
    }
  });

  it("keeps CHECKSUM unchanged with no downgrade reason", () => {
    expect(resolveVerifyPlan("CHECKSUM", "mysql")).toEqual({
      effectiveLevel: "CHECKSUM",
      downgradeReason: null,
    });
  });

  it("keeps NONE unchanged with no downgrade reason", () => {
    expect(resolveVerifyPlan("NONE", "postgres")).toEqual({
      effectiveLevel: "NONE",
      downgradeReason: null,
    });
  });

  it("defaults a missing policy level to CHECKSUM without a downgrade", () => {
    expect(resolveVerifyPlan(null, "postgres")).toEqual({
      effectiveLevel: "CHECKSUM",
      downgradeReason: null,
    });
  });
});

describe("sanitizeReason", () => {
  it("reduces an Error to its name and NEVER echoes the raw message (driver errors embed the URI)", () => {
    const reason = sanitizeReason(new Error("mongodb://user:hunter2@db.internal/app connection refused"));
    expect(reason).toBe("job failed: Error");
    expect(reason).not.toContain("hunter2");
    expect(reason).not.toContain("mongodb://");
  });

  it("preserves a custom error class name without its message", () => {
    class ConnRefused extends Error {
      override name = "ConnRefused";
    }
    expect(sanitizeReason(new ConnRefused("password=s3cret"))).toBe("job failed: ConnRefused");
  });

  it("returns the generic reason for a non-Error throw", () => {
    expect(sanitizeReason("password=s3cret literal")).toBe("job failed: unknown error");
    expect(sanitizeReason({ password: "s3cret" })).toBe("job failed: unknown error");
  });
});

describe("toBackupProbe", () => {
  it("sums per-database sizeBytes into estimatedBytes and carries version/scope", () => {
    const rich: EngineProbeResult = {
      serverVersionNum: 160002,
      databases: [
        { name: "app", sizeBytes: 1000 },
        { name: "reporting", sizeBytes: 2500 },
      ],
      scope: { databases: ["app", "reporting"], schemas: [], collections: [] },
      facts: { isReplicaSet: false, hasMyisam: false },
    };
    expect(toBackupProbe(rich)).toEqual({
      serverVersionNum: 160002,
      scope: { databases: ["app", "reporting"], schemas: [], collections: [] },
      estimatedBytes: 3500,
    });
  });

  it("maps an empty database list to zero estimatedBytes", () => {
    const rich: EngineProbeResult = {
      serverVersionNum: 80004,
      databases: [],
      scope: { databases: [], schemas: [], collections: [] },
      facts: { isReplicaSet: false, hasMyisam: false },
    };
    expect(toBackupProbe(rich).estimatedBytes).toBe(0);
  });
});
