// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { generateAgeKeyPair, type EncryptionKeyRecord } from "./artifact.js";
import { isValidAgeRecipient, provisioningBlockers } from "./key-provisioning.js";

const key = (
  type: "operational" | "escrow",
  state: "active" | "retired" = "active",
): EncryptionKeyRecord => ({
  keyId: `${type}-1`,
  type,
  publicRecipient: `age1${type}`,
  state,
});

describe("isValidAgeRecipient", () => {
  it("accepts a real recipient", async () => {
    expect(isValidAgeRecipient((await generateAgeKeyPair()).recipient)).toBe(true);
  });

  // The checksum is the point. An operator pasting their own offline recipient can transpose one
  // character, and without this the mistake surfaces months later as an artifact nobody can open.
  it("rejects a recipient with a single corrupted character", async () => {
    const good = (await generateAgeKeyPair()).recipient;
    const corrupted = `${good.slice(0, -1)}${good.endsWith("q") ? "p" : "q"}`;
    expect(isValidAgeRecipient(corrupted)).toBe(false);
  });

  it.each(["", "age1nonsense", "ssh-ed25519 AAAAC3Nz", "not-a-key"])(
    "rejects %j",
    (candidate) => {
      expect(isValidAgeRecipient(candidate)).toBe(false);
    },
  );
});

describe("provisioningBlockers", () => {
  it("allows provisioning when the organization has no keys", () => {
    expect(provisioningBlockers([])).toEqual([]);
  });

  // Two active operational keys would make resolveRecipients' `find` pick by row order — a choice
  // nobody made, silently deciding which key seals every future backup.
  it("refuses to add a second active key of a type that already exists", () => {
    expect(provisioningBlockers([key("operational")])).toEqual(["operational"]);
    expect(provisioningBlockers([key("escrow")])).toEqual(["escrow"]);
    expect(provisioningBlockers([key("operational"), key("escrow")])).toEqual([
      "operational",
      "escrow",
    ]);
  });

  // Retired keys stay in the table so old artifacts remain attributable; they must not block a
  // replacement, or an organization could never recover from retiring a key.
  it("ignores retired keys", () => {
    expect(provisioningBlockers([key("operational", "retired"), key("escrow", "retired")])).toEqual(
      [],
    );
  });
});
