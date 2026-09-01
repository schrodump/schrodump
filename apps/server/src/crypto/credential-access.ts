// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Reading a stored credential, and recording that it was read.
//
// docs/lgpd.md described an art. 37 trail and then listed `credential.read` as a gap: decryption
// happens in nine places across job execution and the HTTP layer, and none of them recorded
// anything. A trail that covers who edited a target but not who caused its password to be
// decrypted describes the least sensitive half of what the system does.
//
// The fix is shaped by the lesson of observability/audit.ts. A per-call-site `audit.record(...)`
// is a thing the tenth call site forgets, and a missing record looks exactly like an access that
// never happened. So the context is a REQUIRED argument of the only function allowed to decrypt:
// a new call site cannot compile without saying which organization, which resource and why, and
// eslint refuses a direct import of decryptCredential outside this module.
//
// What is recorded is the access, never the plaintext and never anything derived from it.

import { decryptCredential, parseEncryptedCredential } from "./envelope.js";

export type CredentialResource = "target" | "destination" | "notificationChannel" | "encryptionKey";

export interface CredentialAccess {
  readonly organizationId: string;
  readonly resource: CredentialResource;
  readonly resourceId: string;
  // Why this decryption happened, in words a person reviewing the trail can act on. Free text
  // rather than an enum on purpose: the useful question months later is "what was the system
  // doing", and a closed set would be extended by whoever adds a call site anyway.
  readonly purpose: string;
  // Joins the row to the request or job that caused it — request.id in the HTTP layer, job.id in
  // the worker, so an access can be read next to the log lines around it.
  readonly correlationId: string;
}

export interface CredentialAuditSink {
  // Fire-and-forget by contract. Decryption is synchronous at every call site, and making it
  // async to await a log write would ripple through the whole job pipeline for no gain. The
  // implementation must not throw and must not reject on the caller's stack.
  record(access: CredentialAccess): void;
}

export interface CredentialReaderDeps {
  readonly kek: Buffer;
  readonly audit: CredentialAuditSink;
}

// Records BEFORE decrypting, deliberately. The claim being made is "the system accessed this
// credential", and a failed decryption is still an access attempt worth seeing — a run of them is
// what a wrong KEK or a tampered row looks like. The failure itself lands in the error log under
// the same correlationId, so the two join.
export function readCredential(
  deps: CredentialReaderDeps,
  value: unknown,
  access: CredentialAccess,
): string {
  deps.audit.record(access);
  return decryptCredential(deps.kek, parseEncryptedCredential(value));
}

// For the paths that legitimately hold no organization or no job — none today, and the type is
// here so that a future one has to be written down rather than passing an empty string.
export const SYSTEM_CORRELATION = "system";
