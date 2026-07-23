// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { resolveCapabilities } from "./capabilities.js";
import { ENGINE_KINDS } from "./types.js";

const MIN_VERSION: Record<(typeof ENGINE_KINDS)[number], number> = {
  postgres: 130000,
  mysql: 80000,
  mariadb: 100600,
  mongodb: 60000,
};

describe("resolveCapabilities", () => {
  it("returns the descriptor at the exact minimum supported version", () => {
    for (const engine of ENGINE_KINDS) {
      const caps = resolveCapabilities(engine, MIN_VERSION[engine]);
      expect(caps.engine).toBe(engine);
      expect(caps.supportsPitr).toBe(false);
    }
  });

  it("throws just below the minimum supported version", () => {
    for (const engine of ENGINE_KINDS) {
      expect(() => resolveCapabilities(engine, MIN_VERSION[engine] - 1)).toThrow(RangeError);
    }
  });

  it("keeps mongodb parallelism at 1 pending doc validation", () => {
    const caps = resolveCapabilities("mongodb", 70000);
    expect(caps.maxParallelism).toBe(1);
    expect(caps.stagedCapable).toBe(false);
    expect(caps.streamCapable).toBe(true);
  });

  it("marks postgres as the only engine needing a separate globals dump", () => {
    expect(resolveCapabilities("postgres", 160000).requiresSeparateGlobalsDump).toBe(true);
    expect(resolveCapabilities("mysql", 80400).requiresSeparateGlobalsDump).toBe(false);
    expect(resolveCapabilities("mariadb", 110402).requiresSeparateGlobalsDump).toBe(false);
    expect(resolveCapabilities("mongodb", 70000).requiresSeparateGlobalsDump).toBe(false);
  });

  it("exposes the parallel staged path for the SQL engines", () => {
    for (const engine of ["postgres", "mysql", "mariadb"] as const) {
      const caps = resolveCapabilities(engine, MIN_VERSION[engine]);
      expect(caps.stagedCapable).toBe(true);
      expect(caps.maxParallelism).toBeGreaterThan(1);
    }
  });
});
