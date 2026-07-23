// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomUUID } from "node:crypto";
import { pino, type DestinationStream, type Logger } from "pino";

// Redact anything that could be a credential, at EVERY level including debug. Combined with the
// rule that credentials are never written as free text, none can reach the output.
const REDACT_PATHS = [
  "password",
  "secret",
  "token",
  "kek",
  "secretAccessKey",
  "encryptedCredential",
  "encryptedSecretAccessKey",
  "identity",
  "SCHRODUMP_KEK",
  "DATABASE_URL",
  "*.password",
  "*.secret",
  "*.token",
  "*.kek",
  "*.secretAccessKey",
  "*.encryptedCredential",
  "*.identity",
  "req.headers.authorization",
  "req.headers.cookie",
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, destination);
}

export function newCorrelationId(): string {
  return randomUUID();
}
