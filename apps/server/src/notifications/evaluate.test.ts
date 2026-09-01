// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { evaluateNotifications, type FleetSnapshot } from "./evaluate.js";

const T0 = new Date("2026-08-30T10:00:00Z");
const T1 = new Date("2026-08-30T10:20:00Z");

function snapshot(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return { at: T1, unobserved: 0, failedArtifactIds: [], policies: [], ...over };
}

describe("evaluateNotifications", () => {
  it("opens on an artifact verify proved bad, with no hysteresis at all", () => {
    // The only trigger that fires on a single observation. It is not a count moving — it is a
    // claim about data, produced by a restore that ran and failed.
    const out = evaluateNotifications({
      snapshot: snapshot({ failedArtifactIds: ["a1"] }),
      previous: null,
      delivered: [],
    });
    expect(out).toEqual([
      expect.objectContaining({ trigger: "ARTIFACT_FAILED", key: "a1", kind: "opened" }),
    ]);
  });

  it("stays silent while a healthy backup is briefly unobserved", () => {
    // THE test this feature lives or dies by. Every backup is UNOBSERVED between finishing and its
    // chained verify. A trigger that fires there fires on success, and gets muted within a week —
    // the exact failure docs/roadmap.md warned about.
    const out = evaluateNotifications({
      snapshot: snapshot({ unobserved: 3 }),
      previous: null,
      delivered: [],
    });
    expect(out).toEqual([]);
  });

  it("opens when the unobserved count fails to come down between evaluations", () => {
    const out = evaluateNotifications({
      snapshot: snapshot({ unobserved: 4 }),
      previous: { ...snapshot({ unobserved: 3 }), at: T0 },
      delivered: [],
    });
    expect(out).toEqual([
      expect.objectContaining({ trigger: "VERIFICATION_BEHIND", kind: "opened" }),
    ]);
  });

  it("stays silent when verification is catching up, even with a backlog", () => {
    // A falling count is verification working. A high number alone is not a reason to shout.
    const out = evaluateNotifications({
      snapshot: snapshot({ unobserved: 9 }),
      previous: { ...snapshot({ unobserved: 12 }), at: T0 },
      delivered: [],
    });
    expect(out).toEqual([]);
  });

  it("does not repeat a condition it has already reported", () => {
    const out = evaluateNotifications({
      snapshot: snapshot({ unobserved: 4 }),
      previous: { ...snapshot({ unobserved: 3 }), at: T0 },
      delivered: [{ trigger: "VERIFICATION_BEHIND", key: "", since: T0 }],
    });
    expect(out).toEqual([]);
  });

  it("closes a condition that stopped holding", () => {
    const out = evaluateNotifications({
      snapshot: snapshot({ unobserved: 0 }),
      previous: { ...snapshot({ unobserved: 4 }), at: T0 },
      delivered: [{ trigger: "VERIFICATION_BEHIND", key: "", since: T0 }],
    });
    expect(out).toEqual([
      expect.objectContaining({ trigger: "VERIFICATION_BEHIND", kind: "resolved" }),
    ]);
  });

  it("opens on a policy that has gone quiet for more than twice its interval", () => {
    // The silent death: the scheduler wedged, the target moved, credentials rotated. No
    // failure-based alert can see it, because a job that never runs never fails.
    const out = evaluateNotifications({
      snapshot: snapshot({
        policies: [
          {
            id: "p1",
            name: "nightly",
            expectedIntervalMs: 24 * 60 * 60 * 1000,
            lastSucceededAt: new Date(T1.getTime() - 3 * 24 * 60 * 60 * 1000),
          },
        ],
      }),
      previous: null,
      delivered: [],
    });
    expect(out).toEqual([
      expect.objectContaining({ trigger: "POLICY_QUIET", key: "p1", kind: "opened" }),
    ]);
  });

  it("stays silent for a policy still inside its window", () => {
    const out = evaluateNotifications({
      snapshot: snapshot({
        policies: [
          {
            id: "p1",
            name: "nightly",
            expectedIntervalMs: 24 * 60 * 60 * 1000,
            lastSucceededAt: new Date(T1.getTime() - 60 * 60 * 1000),
          },
        ],
      }),
      previous: null,
      delivered: [],
    });
    expect(out).toEqual([]);
  });

  it("treats a policy that has never succeeded as quiet, not as healthy", () => {
    // A policy created and never run is the same operational hole as one that stopped running, and
    // failing open here would hide exactly the case where nothing was ever backed up.
    const out = evaluateNotifications({
      snapshot: snapshot({
        policies: [
          { id: "p1", name: "nightly", expectedIntervalMs: 60_000, lastSucceededAt: null },
        ],
      }),
      previous: null,
      delivered: [],
    });
    expect(out).toEqual([
      expect.objectContaining({ trigger: "POLICY_QUIET", key: "p1", kind: "opened" }),
    ]);
  });
});
