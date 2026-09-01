// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import type { EncryptionKeyRecord } from "./artifact.js";
import { activeKeyOfType, rotationBlockers, rotationConsequences } from "./key-rotation.js";

function key(over: Partial<EncryptionKeyRecord> = {}): EncryptionKeyRecord {
  return {
    keyId: "k1",
    type: "operational",
    publicRecipient: "age1operational",
    state: "active",
    ...over,
  };
}

describe("rotationBlockers", () => {
  it("allows rotating a type that has exactly one active key", () => {
    expect(rotationBlockers([key()], "operational")).toEqual([]);
  });

  it("refuses to rotate a type that was never provisioned", () => {
    // Rotation succeeds an existing key. An organization with no operational key needs
    // provisioning, and answering it with a rotation would hide that it never had one.
    expect(rotationBlockers([], "operational")).toEqual(["not_provisioned"]);
  });

  it("refuses when only a RETIRED key of the type exists", () => {
    expect(rotationBlockers([key({ state: "retired" })], "operational")).toEqual([
      "not_provisioned",
    ]);
  });

  it("refuses rather than guess when two active keys of a type exist", () => {
    // This state means resolveRecipients' find() has been picking by row order. Retiring one here
    // would be guessing which one it had been picking.
    const keys = [key({ keyId: "k1" }), key({ keyId: "k2" })];

    expect(rotationBlockers(keys, "operational")).toEqual(["ambiguous_active"]);
  });

  it("does not let a key of the OTHER type satisfy the check", () => {
    const keys = [key({ keyId: "e1", type: "escrow", publicRecipient: "age1escrow" })];

    expect(rotationBlockers(keys, "operational")).toEqual(["not_provisioned"]);
    expect(rotationBlockers(keys, "escrow")).toEqual([]);
  });
});

describe("activeKeyOfType", () => {
  it("returns the single active key of the type", () => {
    const escrow = key({ keyId: "e1", type: "escrow", publicRecipient: "age1escrow" });

    expect(activeKeyOfType([key(), escrow], "escrow")).toEqual(escrow);
  });

  it("returns null when the answer would be a guess", () => {
    expect(activeKeyOfType([key({ keyId: "k1" }), key({ keyId: "k2" })], "operational")).toBeNull();
    expect(activeKeyOfType([], "operational")).toBeNull();
    expect(activeKeyOfType([key({ state: "retired" })], "operational")).toBeNull();
  });
});

describe("rotationConsequences", () => {
  it("always says existing artifacts are not re-encrypted", () => {
    expect(rotationConsequences("operational").existingArtifactsUnchanged).toBe(true);
    expect(rotationConsequences("escrow").existingArtifactsUnchanged).toBe(true);
  });

  it("says the server keeps reading predecessor operational artifacts", () => {
    const result = rotationConsequences("operational");

    expect(result.predecessorReadableByServer).toBe(true);
    // Nothing for the operator to file away: the outgoing identity stays in the row, KEK-wrapped.
    expect(result.operatorMustRetain).toBeNull();
  });

  it("tells the operator to keep the outgoing ESCROW identity", () => {
    const result = rotationConsequences("escrow");

    expect(result.predecessorReadableByServer).toBe(false);
    expect(result.operatorMustRetain).toContain("OUTGOING escrow identity");
  });

  it("refuses to let rotation read as remediation for an exposed key", () => {
    // The failure this text prevents: rotate, see green, believe the exposure is closed. It is not
    // — every artifact already written is still sealed to the outgoing recipient.
    for (const type of ["operational", "escrow"] as const) {
      const warning = rotationConsequences(type).doesNotRemediateExposure;

      expect(warning).toContain("already written");
      expect(warning).toMatch(/re-take them, or delete them/);
    }
  });
});
