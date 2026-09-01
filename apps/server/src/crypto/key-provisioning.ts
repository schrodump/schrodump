// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Deciding whether an organization may be given encryption keys, and of which shape.
//
// Until this existed, nothing in the product ever created an EncryptionKey row: generateAgeKeyPair
// was called only by tests, and every production reference was a read. A fresh install therefore
// failed its first backup inside resolveRecipients ("no active operational encryption key") with no
// way to fix it through the interface.
//
// Pure on purpose — the rules about what may be provisioned are worth testing without a database.

import { Encrypter } from "age-encryption";
import type { EncryptionKeyRecord } from "./artifact.js";

// The real check, not a regex. age's own parser verifies the bech32 checksum, so a recipient with a
// single transposed character is rejected here rather than at the first backup — which would
// otherwise be discovered as an unopenable artifact months later.
export function isValidAgeRecipient(recipient: string): boolean {
  try {
    new Encrypter().addRecipient(recipient);
    return true;
  } catch {
    return false;
  }
}

export type ProvisioningBlocker = "operational" | "escrow";

// Provisioning is a first-time action, not rotation. An organization that already holds an active
// key of a given type is refused rather than quietly given a second one: two active operational
// keys would make resolveRecipients' `find` pick by row order, which is not a decision anyone made.
//
// Rotation — retiring a key and issuing its successor while old artifacts stay readable — is a
// separate operation with its own rules, and deliberately not smuggled in here.
export function provisioningBlockers(existing: EncryptionKeyRecord[]): ProvisioningBlocker[] {
  const active = existing.filter((key) => key.state === "active");
  const blockers: ProvisioningBlocker[] = [];
  if (active.some((key) => key.type === "operational")) blockers.push("operational");
  if (active.some((key) => key.type === "escrow")) blockers.push("escrow");
  return blockers;
}
