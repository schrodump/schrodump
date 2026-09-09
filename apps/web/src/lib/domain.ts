// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Domain vocabulary mirrored from @schrodump/core. Re-declared locally (small, stable) to keep
// the web free of workspace-package source-resolution in the Next build.

export const ENGINE_KINDS = ["postgres", "mysql", "mariadb", "mongodb"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

// Ternary — there is no "OK". UNOBSERVED is an open question, not a success.
export const ARTIFACT_STATES = ["VERIFIED", "UNOBSERVED", "FAILED"] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export const VERIFY_LEVELS = ["NONE", "CHECKSUM", "FULL_RESTORE"] as const;
export type VerifyLevel = (typeof VERIFY_LEVELS)[number];

export const JOB_KINDS = ["BACKUP", "RESTORE", "VERIFY", "RETENTION"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

// INCONCLUSIVE: a VERIFY whose sandbox or runner never got to look. No verdict, artifact
// untouched — its own state so the list can filter it, and quiet in the UI, never the failed red.
export const JOB_STATES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "INCONCLUSIVE",
  "CANCELLED",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const EXECUTION_MODES = ["STREAM", "STAGED"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const COMPRESSION_ALGORITHMS = ["none", "zstd", "gzip"] as const;
export type CompressionAlgorithm = (typeof COMPRESSION_ALGORITHMS)[number];

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const SEAL_MODES = ["operational", "sealed"] as const;
export type SealMode = (typeof SEAL_MODES)[number];

export const RESTORE_TARGETS = [
  "FULL_CLUSTER",
  "DATABASE",
  "SCHEMA",
  "TABLE",
  "COLLECTION",
] as const;
export type RestoreTarget = (typeof RESTORE_TARGETS)[number];

// Mirror of the core capability matrix: which restore targets each engine supports. The restore
// flow disables unsupported options instead of letting the user attempt them.
export const RESTORE_TARGETS_BY_ENGINE: Record<EngineKind, readonly RestoreTarget[]> = {
  postgres: ["FULL_CLUSTER", "DATABASE", "SCHEMA", "TABLE"],
  // No TABLE for mysql/mariadb: postgres got it back with pg_restore -t, and MySQL offers nothing
  // equivalent for replaying a dump script — `--one-database` is documented as rudimentary. So a
  // TABLE restore here would run over the whole dump. Withdrawn server-side; this mirror follows.
  mysql: ["FULL_CLUSTER", "DATABASE"],
  mariadb: ["FULL_CLUSTER", "DATABASE"],
  // COLLECTION rather than TABLE — mongo has no tables. Sub-scope came back once buildRestore
  // emitted --nsInclude, which is what scopes mongorestore's --drop to the requested namespace
  // instead of the whole archive; the server proves that against a real mongod. This list is the
  // second lock, kept in sync so the UI never offers a target that will be rejected.
  mongodb: ["FULL_CLUSTER", "DATABASE", "COLLECTION"],
};

// Whether a restore of this artifact can be confined to a single database at all.
//
// mysql/mariadb replay the dump as a SQL script, and their buildRestore emits no scoping flag —
// there is no equivalent of pg_restore's -t or mongorestore's --nsInclude. A script dumped with
// `--databases a b` carries CREATE DATABASE / USE / DROP TABLE for both, so it rewrites both
// whichever one was asked for. Measured on mysql 8.4.10: the neighbour lost a row and the client
// exited 0.
//
// Only a recorded `false` clears this. `null` means the artifact predates the fact being tracked,
// which is a weaker claim than false — and the failure direction decides how to read it, because
// permitting the hazard costs a database while refusing costs a label (a full-cluster restore of
// the same artifact runs the identical command and says what it does). This mirrors the server's
// gate; it does not replace it — the server stays the lock.
export function canConfineRestore(artifact: {
  engine: EngineKind;
  dumpIsMultiDatabase: boolean | null;
}): boolean {
  if (artifact.engine !== "mysql" && artifact.engine !== "mariadb") return true;
  return artifact.dumpIsMultiDatabase === false;
}

// Why the server answers with a code and not a message: driver errors embed the credential they
// failed with. The wording lives in the translation files.
export const PROBE_FAILURE_CODES = [
  "UNREACHABLE",
  "TIMEOUT",
  "AUTH_FAILED",
  "INSUFFICIENT_PRIVILEGES",
  "TLS_FAILED",
  "UNKNOWN",
] as const;
export type ProbeFailureCode = (typeof PROBE_FAILURE_CODES)[number];

// What a scope has to look like for the dump tool to copy what the operator meant. The server holds
// the authoritative copy (routes/targets.ts, scopeProblem) and refuses at the border; this mirror
// lets the form disable Save before a request is ever made. Postgres: pg_dump copies exactly one
// database per run, and an unscoped target would copy `postgres` — the maintenance database, which
// on a real deployment produced an 876-byte backup of nothing under a SUCCEEDED job. MongoDB: one
// database, or none for the whole instance, which is also what a replica set requires.
export type ScopeProblem = "postgres" | "mongodb";
export function scopeProblemCode(
  engine: EngineKind,
  databases: readonly string[],
): ScopeProblem | null {
  if (engine === "postgres" && databases.length !== 1) return "postgres";
  if (engine === "mongodb" && databases.length > 1) return "mongodb";
  return null;
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function canRestore(role: Role): boolean {
  return RANK[role] >= RANK.operator;
}

// Deleting an artifact is operator+, like restore: a viewer never sees the control, and the server
// refuses the call regardless (the UI gate is the second lock, not the only one).
export function canDeleteArtifact(role: Role): boolean {
  return RANK[role] >= RANK.operator;
}

// Targets, destinations and policies are configuration: operator+ writes them, a viewer reads
// them. The server enforces the same line on every write route.
export function canManageTargets(role: Role): boolean {
  return RANK[role] >= RANK.operator;
}
