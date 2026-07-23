// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  buildAgeDecryptDescriptor,
  buildAgeEncryptDescriptor,
  generateAgeKeyPair,
  recipientFingerprint,
  resolveDecryptionKeyId,
  resolveRecipients,
  type EncryptionKeyRecord,
} from "./artifact.js";

describe("buildAgeEncryptDescriptor", () => {
  it("emits one -r per recipient and reads/writes via stdout", () => {
    const descriptor = buildAgeEncryptDescriptor(["age1op", "age1escrow"]);
    expect(descriptor.command).toEqual(["age", "--encrypt", "-r", "age1op", "-r", "age1escrow"]);
    expect(descriptor.outputKind).toBe("stdout");
    expect(descriptor.env).toEqual({});
  });

  it("refuses fewer than two recipients (operational + escrow are mandatory)", () => {
    expect(() => buildAgeEncryptDescriptor(["age1op"])).toThrow();
  });
});

describe("buildAgeDecryptDescriptor", () => {
  it("references a mounted identity file, never argv", () => {
    const descriptor = buildAgeDecryptDescriptor();
    expect(descriptor.command).toEqual(["age", "--decrypt", "-i", "/etc/schrodump/age-identity"]);
    for (const arg of descriptor.command) {
      expect(arg).not.toContain("AGE-SECRET-KEY");
    }
  });
});

describe("resolveRecipients", () => {
  const keys: EncryptionKeyRecord[] = [
    { keyId: "op", type: "operational", publicRecipient: "age1op", state: "active" },
    { keyId: "esc", type: "escrow", publicRecipient: "age1escrow", state: "active" },
    { keyId: "old", type: "operational", publicRecipient: "age1old", state: "retired" },
  ];

  it("picks the active operational and escrow recipients", () => {
    const { recipients, keyIds } = resolveRecipients(keys);
    expect(recipients).toEqual(["age1op", "age1escrow"]);
    expect(keyIds).toEqual(["op", "esc"]);
  });

  it("throws when there is no active escrow key", () => {
    expect(() => resolveRecipients(keys.filter((key) => key.type !== "escrow"))).toThrow();
  });
});

describe("resolveDecryptionKeyId", () => {
  const keys: EncryptionKeyRecord[] = [
    { keyId: "op-new", type: "operational", publicRecipient: "age1new", state: "active" },
    { keyId: "esc", type: "escrow", publicRecipient: "age1escrow", state: "active" },
  ];

  it("resolves the key from the manifest, not global config", () => {
    expect(resolveDecryptionKeyId(["op-new", "esc"], keys)).toBe("op-new");
  });

  it("returns null when the server holds no matching operational identity (sealed)", () => {
    expect(resolveDecryptionKeyId(["esc"], keys)).toBeNull();
  });
});

describe("generateAgeKeyPair", () => {
  it("produces an X25519 identity, its recipient, and a stable fingerprint", async () => {
    const pair = await generateAgeKeyPair();
    expect(pair.identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(pair.recipient).toMatch(/^age1/);
    expect(pair.keyId).toBe(recipientFingerprint(pair.recipient));
  });
});
