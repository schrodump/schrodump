// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { canRestore, channelState, ENGINE_KINDS, RESTORE_TARGETS_BY_ENGINE } from "./domain";

describe("canRestore", () => {
  it("allows operator and admin but never viewer", () => {
    expect(canRestore("admin")).toBe(true);
    expect(canRestore("operator")).toBe(true);
    expect(canRestore("viewer")).toBe(false);
  });
});

describe("RESTORE_TARGETS_BY_ENGINE", () => {
  it("covers every engine, so a new one cannot render an undefined target list", () => {
    // Replaces a test that looped the engines through a predicate which could not fail. This one
    // can: adding an engine to ENGINE_KINDS without a row here makes `supported` undefined in the
    // restore dialog, and `supported.includes` throws on the first render.
    for (const engine of ENGINE_KINDS) {
      expect(RESTORE_TARGETS_BY_ENGINE[engine]).toBeDefined();
      expect(RESTORE_TARGETS_BY_ENGINE[engine]).toContain("FULL_CLUSTER");
    }
  });

  it("mirrors the capability matrix: postgres has SCHEMA, mongodb has neither", () => {
    expect(RESTORE_TARGETS_BY_ENGINE.postgres).toContain("SCHEMA");
    expect(RESTORE_TARGETS_BY_ENGINE.postgres).not.toContain("COLLECTION");
    expect(RESTORE_TARGETS_BY_ENGINE.mongodb).not.toContain("SCHEMA");
  });

  it("mirrors the server's mongodb targets exactly, in mongo's own vocabulary", () => {
    // Not a UI preference — a mirror. The server's capability matrix is the lock, and this list
    // decides what the restore dialog offers; drift in either direction is a bug, but only drift
    // that offers MORE than the server accepts puts a button in front of a guaranteed rejection.
    // Sub-scope returned once buildRestore emitted --nsInclude, which is what scopes --drop.
    expect(RESTORE_TARGETS_BY_ENGINE.mongodb).toEqual(["FULL_CLUSTER", "DATABASE", "COLLECTION"]);
  });
});

// A channel nobody has watched deliver is an open question, not a working channel — the same law
// the artifacts obey, applied to the thing that is supposed to tell you about them. It matters
// here for a reason the repository has already paid for once: a JSON.parse bug meant webhook and
// SMTP notifications had never delivered anything, permanently, and the interface showed the
// channels exactly as it showed a healthy one. See wiring.ts.
describe("channelState", () => {
  it("is UNOBSERVED when nothing has ever been delivered through it", () => {
    expect(channelState({ lastSuccessAt: null, lastFailureAt: null })).toBe("UNOBSERVED");
  });

  it("is VERIFIED once a delivery has actually arrived", () => {
    expect(channelState({ lastSuccessAt: "2026-09-10T12:00:00Z", lastFailureAt: null })).toBe("VERIFIED");
  });

  it("is FAILED when the only thing it has done is fail", () => {
    expect(channelState({ lastSuccessAt: null, lastFailureAt: "2026-09-10T12:00:00Z" })).toBe("FAILED");
  });

  it("reads the most recent event, so a channel that was fixed stops claiming to be broken", () => {
    expect(
      channelState({ lastSuccessAt: "2026-09-10T12:05:00Z", lastFailureAt: "2026-09-10T12:00:00Z" }),
    ).toBe("VERIFIED");
  });

  it("reads the most recent event, so a channel that broke stops claiming to be verified", () => {
    expect(
      channelState({ lastSuccessAt: "2026-09-10T12:00:00Z", lastFailureAt: "2026-09-10T12:05:00Z" }),
    ).toBe("FAILED");
  });

  it("calls a tie FAILED, because the safe reading of an ambiguous channel is the pessimistic one", () => {
    const same = "2026-09-10T12:00:00Z";
    expect(channelState({ lastSuccessAt: same, lastFailureAt: same })).toBe("FAILED");
  });
});

it("orders the two events by instant, not by how the timestamp happens to be spelled", () => {
  // Lexicographic ordering of ISO strings only works while both are spelled identically. "." sorts
  // before "Z", so a success half a second AFTER the failure reads as older and the channel claims
  // to be broken. Today Fastify always serialises with milliseconds and the two agree by accident;
  // that accident is not a thing to depend on.
  expect(
    channelState({ lastSuccessAt: "2026-09-10T12:00:00.500Z", lastFailureAt: "2026-09-10T12:00:00Z" }),
  ).toBe("VERIFIED");
});
