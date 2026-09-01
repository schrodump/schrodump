// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Retiring an encryption key and issuing its successor.
//
// The read paths were built for this before the write existed: every place that resolves a
// decryption key queries encryptionKey WITHOUT filtering on state, with the comment "ALL keys
// (active + retired): an artifact may have been encrypted with a now-retired key". Rotation is
// therefore not a migration — nothing is re-encrypted and nothing moves. It changes which key the
// NEXT backup seals to, and leaves every existing artifact readable through the key it was written
// with.
//
// Which is also the limit worth being loud about. See rotationConsequences below.
//
// Pure on purpose: the rules are worth testing without a database.

import type { EncryptionKeyRecord } from "./artifact.js";

export type KeyType = "operational" | "escrow";

export type RotationBlocker = "not_provisioned" | "ambiguous_active";

// Rotation succeeds an EXISTING key. It is not a way to provision a missing one, and it is not a
// way to resolve an organization that somehow holds two active keys of a type — that state means
// `resolveRecipients`' `find` has been choosing by row order, and picking one to retire here would
// be guessing which one it had been choosing.
export function rotationBlockers(
  existing: EncryptionKeyRecord[],
  type: KeyType,
): RotationBlocker[] {
  const active = existing.filter((key) => key.state === "active" && key.type === type);
  if (active.length === 0) return ["not_provisioned"];
  if (active.length > 1) return ["ambiguous_active"];
  return [];
}

// The single active key of a type, or null. Callers that have already checked rotationBlockers get
// a non-null answer; this exists so they do not repeat the filter and drift from it.
export function activeKeyOfType(
  existing: EncryptionKeyRecord[],
  type: KeyType,
): EncryptionKeyRecord | null {
  const active = existing.filter((key) => key.state === "active" && key.type === type);
  return active.length === 1 ? (active[0] as EncryptionKeyRecord) : null;
}

export interface RotationConsequences {
  // Artifacts already in the bucket are NOT re-encrypted. Always true; stated as data so the API
  // response and the UI cannot quietly stop saying it.
  readonly existingArtifactsUnchanged: true;
  // Whether the server can still open the artifacts sealed to the outgoing key on its own.
  readonly predecessorReadableByServer: boolean;
  // What the operator must keep, in their own words, or null when there is nothing for them to do.
  readonly operatorMustRetain: string | null;
  // Set when rotation is being used as a response to exposure, because it does less than it looks.
  readonly doesNotRemediateExposure: string;
}

// What rotating this key does and — more important — what it does not.
//
// The failure this text exists to prevent: an operator whose key has leaked rotates it, sees a
// green confirmation, and believes the exposure is closed. It is not. Every artifact already
// written is still sealed to the compromised recipient, and whoever holds that identity can still
// open all of them. Rotation contains the future; it does not repair the past. The only thing that
// would repair the past is re-encrypting or destroying those artifacts, and the honest move is to
// say so rather than let a success message imply otherwise.
export function rotationConsequences(type: KeyType): RotationConsequences {
  const doesNotRemediateExposure =
    "Rotation seals FUTURE backups to the new key. Every artifact already written stays sealed to " +
    "the outgoing recipient, and anyone holding the outgoing identity can still open all of them. " +
    "If this key was exposed, treat those artifacts as exposed too: re-take them, or delete them.";

  if (type === "operational") {
    return {
      existingArtifactsUnchanged: true,
      // The outgoing operational identity stays in the row, KEK-wrapped. Deleting it would make
      // every artifact sealed to it unopenable by the server — which is the one thing rotation
      // must never do.
      predecessorReadableByServer: true,
      operatorMustRetain: null,
      doesNotRemediateExposure,
    };
  }

  return {
    existingArtifactsUnchanged: true,
    // Escrow identities are never stored, by design — that is what makes them a recovery path when
    // the metadata database is gone.
    predecessorReadableByServer: false,
    operatorMustRetain:
      "Keep the OUTGOING escrow identity. It is the only key that can open the self-backups and " +
      "artifacts written before this rotation, and Schrodump has never held a copy of it.",
    doesNotRemediateExposure,
  };
}
