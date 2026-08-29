// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { SchrodumpError } from "@schrodump/core/errors";
import { describe, expect, it } from "vitest";
import { classifyVerifyError } from "./verify-wiring.js";

const err = (code: string) => new SchrodumpError("x", { code, correlationId: "c" });

describe("classifyVerifyError", () => {
  it("classifies a source failure as INCONCLUSIVE — our infra, not the artifact", () => {
    expect(classifyVerifyError(err("RESTORE_SOURCE_FAILED"))).toBe("INCONCLUSIVE");
  });

  it("classifies runner failures as INCONCLUSIVE", () => {
    expect(classifyVerifyError(err("RUNNER_SERVICE_NOT_READY"))).toBe("INCONCLUSIVE");
    expect(classifyVerifyError(err("RUNNER_TIMEOUT"))).toBe("INCONCLUSIVE");
    expect(classifyVerifyError(err("RUNNER_NETWORK_MISSING"))).toBe("INCONCLUSIVE");
  });

  it("classifies a shutdown abort as INCONCLUSIVE, never FAILED — it observed nothing", () => {
    expect(classifyVerifyError(err("RUNNER_ABORTED"))).toBe("INCONCLUSIVE");
  });

  it("classifies a decrypt failure as FAILED — the artifact itself is bad", () => {
    expect(classifyVerifyError(err("RESTORE_DECRYPT_FAILED"))).toBe("FAILED");
  });

  it("classifies an executor failure as FAILED — the restore ran and rejected the dump", () => {
    expect(classifyVerifyError(err("RESTORE_EXECUTOR_FAILED"))).toBe("FAILED");
  });

  it("classifies a scratch write failure as INCONCLUSIVE — our disk failed, not the artifact", () => {
    expect(classifyVerifyError(err("RESTORE_WRITE_FAILED"))).toBe("INCONCLUSIVE");
  });

  it("never FAILs a backup on a surprise — a non-SchrodumpError is INCONCLUSIVE", () => {
    expect(classifyVerifyError(new Error("surprise"))).toBe("INCONCLUSIVE");
  });
});
