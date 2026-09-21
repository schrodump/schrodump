// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  decryptStream,
  encryptStream,
  generateAgeKeyPair,
  recipientFingerprint,
  recipientsForSealMode,
  resolveDecryptionKeyId,
  resolveRecipients,
  resolveSealedRecipients,
  type EncryptionKeyRecord,
} from "./artifact.js";

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

// "Sealed" promised an instance that can write artifacts it cannot read, and delivered one that
// sealed to the operational key too — whose identity the server holds. These prove the promise on
// real age encryption, not on a list of strings.
describe("resolveSealedRecipients", () => {
  it("seals to the active escrow recipient alone", () => {
    const keys: EncryptionKeyRecord[] = [
      { keyId: "op", type: "operational", publicRecipient: "age1op", state: "active" },
      { keyId: "esc", type: "escrow", publicRecipient: "age1escrow", state: "active" },
      { keyId: "old-esc", type: "escrow", publicRecipient: "age1oldescrow", state: "retired" },
    ];
    expect(resolveSealedRecipients(keys)).toEqual({ recipients: ["age1escrow"], keyIds: ["esc"] });
  });

  it("refuses rather than seal to nothing when there is no active escrow key", () => {
    expect(() =>
      resolveSealedRecipients([{ keyId: "op", type: "operational", publicRecipient: "age1op", state: "active" }]),
    ).toThrow(/escrow/);
  });

  it("picks by the destination's seal mode", () => {
    const keys: EncryptionKeyRecord[] = [
      { keyId: "op", type: "operational", publicRecipient: "age1op", state: "active" },
      { keyId: "esc", type: "escrow", publicRecipient: "age1escrow", state: "active" },
    ];
    expect(recipientsForSealMode("sealed", keys).keyIds).toEqual(["esc"]);
    expect(recipientsForSealMode("operational", keys).keyIds).toEqual(["op", "esc"]);
  });

  it("writes an artifact the operational identity cannot open and the escrow identity can", async () => {
    const operational = await generateAgeKeyPair();
    const escrow = await generateAgeKeyPair();
    const { recipients } = recipientsForSealMode("sealed", [
      { keyId: "op", type: "operational", publicRecipient: operational.recipient, state: "active" },
      { keyId: "esc", type: "escrow", publicRecipient: escrow.recipient, state: "active" },
    ]);
    const collect = async (stream: Readable): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    };
    const ciphertext = await collect(await encryptStream(Readable.from([Buffer.from("the dump")]), recipients));

    const opened = await collect(await decryptStream(Readable.from([ciphertext]), escrow.identity));
    expect(opened.toString()).toBe("the dump");
    await expect(
      (async () => collect(await decryptStream(Readable.from([ciphertext]), operational.identity)))(),
    ).rejects.toThrow();
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
