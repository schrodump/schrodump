// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Artifact encryption uses age, NOT hand-rolled crypto. AES-GCM has a data limit per key/nonce
// pair, and a large dump encrypted as a single GCM stream silently exceeds it. age's STREAM
// construction already solves chunking, per-chunk authentication and truncation detection.
//
// Encryption/decryption run the audited `age` BINARY in an ephemeral executor via the runner —
// no reimplementation. Key GENERATION uses the official age JS library (age-encryption).
//
// Pipeline order is fixed: dump -> compression -> encryption. Never inverted (compressing
// ciphertext is useless and leaks nothing; encrypting first would defeat compression).

import { createHash } from "node:crypto";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import type { ExecutionDescriptor } from "@schrodump/core/execution";

// Executor image carrying the audited `age` binary (built separately, like the engine executors).
const AGE_IMAGE = "schrodump/age:1";
// Where the runner mounts the decryption identity — never passed on argv.
const AGE_IDENTITY_PATH = "/etc/schrodump/age-identity";

export interface AgeKeyPair {
  // AGE-SECRET-KEY-1... — held server-side (operational) or offline by the operator (escrow).
  identity: string;
  // age1... — the public recipient.
  recipient: string;
  // Fingerprint of the recipient.
  keyId: string;
}

export function recipientFingerprint(recipient: string): string {
  return createHash("sha256").update(recipient).digest("hex");
}

export async function generateAgeKeyPair(): Promise<AgeKeyPair> {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient, keyId: recipientFingerprint(recipient) };
}

export interface EncryptionKeyRecord {
  readonly keyId: string;
  readonly type: "operational" | "escrow";
  readonly publicRecipient: string;
  readonly state: "active" | "retired";
}

// Always encrypt for BOTH the operational and the escrow recipient. The extra bytes are
// irrelevant and this is what makes key loss survivable.
export function resolveRecipients(keys: EncryptionKeyRecord[]): {
  recipients: string[];
  keyIds: string[];
} {
  const active = keys.filter((key) => key.state === "active");
  const operational = active.find((key) => key.type === "operational");
  const escrow = active.find((key) => key.type === "escrow");
  if (operational === undefined) throw new Error("no active operational encryption key");
  if (escrow === undefined) throw new Error("no active escrow encryption key");
  return {
    recipients: [operational.publicRecipient, escrow.publicRecipient],
    keyIds: [operational.keyId, escrow.keyId],
  };
}

export function buildAgeEncryptDescriptor(recipients: string[]): ExecutionDescriptor {
  if (recipients.length < 2) {
    throw new Error("artifact encryption requires at least two recipients (operational + escrow)");
  }
  // Public recipients are safe on argv; the identity (secret) never is (see decrypt below).
  const recipientArgs = recipients.flatMap((recipient) => ["-r", recipient]);
  return {
    image: AGE_IMAGE,
    command: ["age", "--encrypt", ...recipientArgs],
    env: {},
    outputKind: "stdout",
  };
}

export function buildAgeDecryptDescriptor(): ExecutionDescriptor {
  // The identity is delivered as a mounted file at AGE_IDENTITY_PATH (from the operational key,
  // or supplied in-memory by the operator in sealed mode) — never on argv.
  return {
    image: AGE_IMAGE,
    command: ["age", "--decrypt", "-i", AGE_IDENTITY_PATH],
    env: {},
    outputKind: "stdout",
  };
}

// Restore resolves the decryption key from the MANIFEST's keyIds, never from global config. It
// returns a key the server can actually decrypt with (operational), or null when the artifact is
// sealed and the operator must supply an identity in memory.
export function resolveDecryptionKeyId(
  manifestKeyIds: string[],
  availableKeys: EncryptionKeyRecord[],
): string | null {
  const match = availableKeys.find(
    (key) => key.type === "operational" && manifestKeyIds.includes(key.keyId),
  );
  return match?.keyId ?? null;
}
