// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Envelope encryption for metadata-database credentials (target passwords, S3 secret keys).
// A fresh DEK per credential encrypts the plaintext; the DEK is then wrapped by the KEK. This
// is for SMALL secrets only — artifact streams use age (see crypto/artifact.ts).
//
// Credentials are write-only from the user's perspective: decryptCredential runs server-side to
// build a connection, and its result is NEVER returned in an API response.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export const EncryptedCredentialSchema = z.object({
  v: z.literal(1),
  // KEK-wrapped DEK (base64 of nonce || ciphertext || tag).
  dek: z.string().min(1),
  // DEK-encrypted plaintext (base64 of nonce || ciphertext || tag).
  data: z.string().min(1),
});

export type EncryptedCredential = z.infer<typeof EncryptedCredentialSchema>;

function seal(key: Buffer, plaintext: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
}

function open(key: Buffer, blob: string): Buffer {
  const buf = Buffer.from(blob, "base64");
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptCredential(kek: Buffer, plaintext: string): EncryptedCredential {
  const dek = randomBytes(32);
  const data = seal(dek, Buffer.from(plaintext, "utf8"));
  const wrappedDek = seal(kek, dek);
  return { v: 1, dek: wrappedDek, data };
}

export function decryptCredential(kek: Buffer, blob: EncryptedCredential): string {
  const dek = open(kek, blob.dek);
  return open(dek, blob.data).toString("utf8");
}

// Validates a value read from a Prisma Json column before decryption.
export function parseEncryptedCredential(value: unknown): EncryptedCredential {
  return EncryptedCredentialSchema.parse(value);
}
