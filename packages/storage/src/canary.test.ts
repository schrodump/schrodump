// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { runCanary, type CanaryOps } from "./canary.js";

function ops(over: Partial<CanaryOps> = {}): CanaryOps {
  return {
    put: async () => undefined,
    get: async () => undefined,
    delete: async () => undefined,
    ...over,
  };
}

describe("runCanary", () => {
  it("reports healthy and runs PUT -> GET -> DELETE in order", async () => {
    const calls: string[] = [];
    const result = await runCanary("k", {
      put: async () => void calls.push("put"),
      get: async () => void calls.push("get"),
      delete: async () => void calls.push("delete"),
    });
    expect(result.ok).toBe(true);
    expect(result.failedOperation).toBeNull();
    expect(calls).toEqual(["put", "get", "delete"]);
  });

  it("flags delete when the key lacks s3:DeleteObject", async () => {
    const result = await runCanary(
      "k",
      ops({
        delete: () => Promise.reject(new Error("AccessDenied")),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failedOperation).toBe("delete");
  });

  it("stops at put and does not attempt get/delete when put fails", async () => {
    const calls: string[] = [];
    const result = await runCanary("k", {
      put: () => {
        calls.push("put");
        return Promise.reject(new Error("fail"));
      },
      get: async () => void calls.push("get"),
      delete: async () => void calls.push("delete"),
    });
    expect(result.failedOperation).toBe("put");
    expect(calls).toEqual(["put"]);
  });

  it("never leaks the underlying error in the health message", async () => {
    const result = await runCanary(
      "k",
      ops({
        get: () => Promise.reject(new Error("postgres://user:s3cret@host")),
      }),
    );
    expect(result.failedOperation).toBe("get");
    expect(result.message).not.toContain("s3cret");
  });
});
