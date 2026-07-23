// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, parseEncryptedCredential } from "./envelope.js";

const KEK = randomBytes(32);

describe("envelope encryption", () => {
  it("round-trips a credential", () => {
    const blob = encryptCredential(KEK, "super-secret-password");
    expect(decryptCredential(KEK, blob)).toBe("super-secret-password");
  });

  it("produces fresh ciphertext each time (new DEK and nonce)", () => {
    const a = encryptCredential(KEK, "x");
    const b = encryptCredential(KEK, "x");
    expect(a.data).not.toBe(b.data);
    expect(a.dek).not.toBe(b.dek);
  });

  it("fails to decrypt with the wrong KEK", () => {
    const blob = encryptCredential(KEK, "secret");
    expect(() => decryptCredential(randomBytes(32), blob)).toThrow();
  });

  it("never exposes the plaintext in the stored blob", () => {
    const blob = encryptCredential(KEK, "s3cret-value");
    expect(JSON.stringify(blob)).not.toContain("s3cret-value");
  });

  it("validates the blob shape on read", () => {
    expect(() => parseEncryptedCredential({ v: 2, dek: "x", data: "y" })).toThrow();
    const blob = encryptCredential(KEK, "z");
    expect(parseEncryptedCredential(JSON.parse(JSON.stringify(blob)))).toEqual(blob);
  });
});
