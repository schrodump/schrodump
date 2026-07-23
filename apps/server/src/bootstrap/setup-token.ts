// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { createHash, randomBytes } from "node:crypto";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 60 minutes

export function generateSetupToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSetupToken(token) };
}

// Only the hash is persisted; the raw token lives only in the log line and the operator's URL.
export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function setupTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + TOKEN_TTL_MS);
}

export interface SetupTokenRecord {
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

// Usable only if it exists, has not been consumed, and has not expired.
export function isSetupTokenUsable(record: SetupTokenRecord | null, now: Date): boolean {
  if (record === null) return false;
  if (record.consumedAt !== null) return false;
  return record.expiresAt.getTime() > now.getTime();
}
