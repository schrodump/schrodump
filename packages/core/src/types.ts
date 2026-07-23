// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Domain vocabulary. Each union is declared as a `const` tuple so the same values
// feed Zod enums and runtime iteration without being duplicated.

export const ENGINE_KINDS = ["postgres", "mysql", "mariadb", "mongodb"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

export const EXECUTION_MODES = ["STREAM", "STAGED"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

// Ternary on purpose — there is no "OK". A backup whose restore was never observed
// is UNOBSERVED, never assumed good.
export const BACKUP_STATES = ["VERIFIED", "UNOBSERVED", "FAILED"] as const;
export type BackupState = (typeof BACKUP_STATES)[number];

export const RESTORE_TARGETS = [
  "FULL_CLUSTER",
  "DATABASE",
  "SCHEMA",
  "TABLE",
  "COLLECTION",
] as const;
export type RestoreTarget = (typeof RESTORE_TARGETS)[number];

export const VERIFY_LEVELS = ["NONE", "CHECKSUM", "FULL_RESTORE"] as const;
export type VerifyLevel = (typeof VERIFY_LEVELS)[number];

export const COMPRESSION_ALGORITHMS = ["none", "zstd", "gzip"] as const;
export type CompressionAlgorithm = (typeof COMPRESSION_ALGORITHMS)[number];
