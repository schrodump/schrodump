// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// A descriptor says WHAT to run; it never runs anything (that is the runner's job).
//
// CREDENTIAL RULE: no credential may ever appear in `command`. Process arguments are visible
// to any process on the host (`ps`, /proc). Credentials travel ONLY through `env`
// (PGPASSWORD, MYSQL_PWD) or a mounted config file (mongo, via `--config`).

import type { EngineKind, ExecutionMode, RestoreTarget } from "@schrodump/core/types";
import type { ExecutionDescriptor } from "@schrodump/core/execution";

// ExecutionDescriptor / BuildWarning are the shared contract between engines and runner, so
// they live in core; re-exported here for this package's consumers.
export type { BuildWarning, ExecutionDescriptor } from "@schrodump/core/execution";

export interface TargetConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  // Routed into `env` or a mounted config file by the adapter — never into `command`.
  readonly password: string;
  // TLS is required by default; turning it off is an explicit, recorded choice on the target,
  // never a silent fallback.
  readonly tls: boolean;
  // The target's CA certificate (PEM), when the operator supplied one. Its presence is what turns
  // `tls` from "encrypted" into "encrypted AND the server proved who it is" — see tlsModeOf. The
  // descriptors never carry the PEM itself: they name TLS_CA_PATH, and the composer mounts the file
  // there. A CA certificate is public, so this is not a credential and needs none of the handling
  // `password` gets.
  readonly tlsCaCert?: string;
}

// Where every executor finds the target's CA certificate. The composer (apps/server) writes the PEM
// onto the scratch volume and bind-mounts it here READ-ONLY; the descriptors only ever name the path.
// Exported so the composer mounts THIS path rather than hardcoding it — the same contract as the
// mongo adapter's MONGO_CONFIG_PATH. A descriptor that names it without the mount fails with a
// missing file, which is the direction to fail in: never a connection that quietly stopped verifying.
export const TLS_CA_PATH = "/etc/schrodump/tls-ca.pem";

// What a target's TLS settings ask for, spelled the way libpq spells it:
//   disable      — no TLS at all (the operator turned it off, on the record).
//   require      — encrypted. For postgres and mysql/mariadb the server's certificate is NOT
//                  verified; mongodb's tools verify against the image's system trust store here
//                  anyway (their own default, and Atlas uses public CAs).
//   verify-full  — encrypted, the chain verified against the target's own CA, and the host name
//                  checked against the certificate.
//
// The ONE reading of those settings. The probe and every descriptor call this, because the defect it
// replaced was the two disagreeing: the probe verified strictly against Node's bundled CAs while
// pg_dump ran `sslmode=require` and verified nothing, so a server with a provider CA failed the probe
// — and with it every backup, which probes first — and a server that did connect was dumped over a
// channel open to anyone in the middle.
export type TlsMode = "disable" | "require" | "verify-full";

export type TargetTls =
  | { readonly mode: "disable" }
  | { readonly mode: "require" }
  | { readonly mode: "verify-full"; readonly caCert: string };

// A CA with TLS off is inert, not an error. The API refuses to be handed both at once, but a row can
// still hold a CA while TLS is off — the operator switched TLS off after pasting one, and keeping it
// means switching TLS back on comes back verified. TLS off is the explicit choice, and it is what
// this reads.
export function targetTlsOf(connection: {
  readonly tls: boolean;
  readonly tlsCaCert?: string;
}): TargetTls {
  if (!connection.tls) return { mode: "disable" };
  return connection.tlsCaCert === undefined
    ? { mode: "require" }
    : { mode: "verify-full", caCert: connection.tlsCaCert };
}

export function tlsModeOf(connection: { readonly tls: boolean; readonly tlsCaCert?: string }): TlsMode {
  return targetTlsOf(connection).mode;
}

export interface DumpScope {
  readonly databases: string[];
  readonly schemas: string[];
  readonly collections: string[];
  // Optional, unlike its siblings: most scopes have no table dimension, and making it required
  // would touch every scope literal in the workspace to say `tables: []`. A TABLE restore that
  // finds it absent or empty is REFUSED rather than widened — see postgres buildRestore.
  readonly tables?: string[];
}

// Facts discovered by the probe that change how a dump must be built.
export interface TargetFacts {
  readonly isReplicaSet: boolean;
  readonly hasMyisam: boolean;
  // postgres: whether the connected role may SELECT from pg_authid, the catalog that holds role
  // password hashes. pg_dumpall reads pg_authid unless told --no-role-passwords, and only a
  // superuser (or a role a superuser explicitly granted it to) may — so on every managed service
  // (RDS, Cloud SQL, Azure, Supabase, Neon, ...) and for any least-privilege role this is false,
  // and a globals dump that asks for passwords fails the whole backup. false for the other engines,
  // which have no such catalog; nothing reads it there.
  readonly canReadRolePasswords: boolean;
}

export interface DumpInput {
  readonly connection: TargetConnection;
  // Probed server version; the adapter resolves the executor image from it via imageFor.
  readonly serverVersionNum: number;
  readonly executionMode: ExecutionMode;
  readonly parallelism: number;
  readonly scope: DumpScope;
  readonly facts: TargetFacts;
  // Output directory inside the executor when executionMode === 'STAGED'.
  readonly stagingPath?: string;
}

export interface RestoreInput {
  readonly connection: TargetConnection;
  readonly serverVersionNum: number;
  readonly target: RestoreTarget;
  readonly scope: DumpScope;
  // The artifact's own execution mode (not a preference — the gate in restore.ts already refused
  // anything but STREAM, so this is always "STREAM" in v1; carried anyway so a descriptor is honest
  // about what it was asked to restore, mirroring DumpInput.executionMode).
  readonly executionMode: ExecutionMode;
  // Path to the artifact inside the executor (stream on stdin or a staged directory).
  readonly sourcePath?: string;
  // Whether the SOURCE archive was dumped with an oplog — mongodb's buildDump emits --oplog exactly
  // when it dumped a replica set. Recorded at dump time and carried on the artifact, never
  // re-derived here: the origin's topology may have changed, or the origin may be gone. `undefined`
  // means the artifact predates the fact being tracked, which is NOT the same claim as `false`.
  readonly sourceHasOplog?: boolean;
}

export interface VerifyInput {
  readonly connection: TargetConnection;
  readonly serverVersionNum: number;
  readonly scope: DumpScope;
}

export interface VerifySandbox {
  readonly image: string;
  readonly env: Record<string, string>;
  readonly readinessCommand: string[];
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export interface EngineAdapter {
  readonly kind: EngineKind;
  imageFor(serverVersionNum: number): string;
  buildDump(input: DumpInput): ExecutionDescriptor;
  buildRestore(input: RestoreInput): ExecutionDescriptor;
  buildVerifyAssertions(input: VerifyInput): ExecutionDescriptor;
  // Only postgres implements this: pg_dumpall --globals-only, a descriptor separate from the
  // per-database dump (see capability `requiresSeparateGlobalsDump`).
  buildGlobalsDump?(input: DumpInput): ExecutionDescriptor;
  // The dual of buildGlobalsDump: restore the plain-SQL globals script (roles/tablespaces) via
  // psql. Only postgres implements it; pg_restore cannot read the plain SQL pg_dumpall emits, so
  // globals need their own restore descriptor, run before the per-database restore.
  buildGlobalsRestore?(input: RestoreInput): ExecutionDescriptor;
  // Describe the ephemeral sandbox container for FULL_RESTORE verify, where the artifact is
  // restored to prove it (image, bootstrap env, readiness probe, credentials). `database` is the
  // artifact's origin database name: postgres ignores it (a -Fc dump is db-name-agnostic, so the
  // sandbox always uses a fixed "verify" db), but mysql/mariadb restores INTO the origin db name
  // (mysqldump's `USE <origin>` / a single-db dump has no CREATE DATABASE), so their sandboxes
  // must pre-create it.
  buildVerifySandbox?(serverVersionNum: number, password: string, database: string): VerifySandbox;
  // Why this engine's STAGED tool cannot connect to this target the way its TLS mode asks, or null
  // when it can. Only mysql/mariadb implement it: mydumper and myloader have no way to require TLS
  // without also verifying the certificate — `--ssl-mode=REQUIRED` falls back to plaintext when the
  // server offers none (measured against schrodump/mydumper:1). apps/server reads it BEFORE choosing
  // the execution mode, so such a target streams instead; the STAGED descriptors refuse on the same
  // answer as the second lock.
  stagedTlsRefusal?(connection: TargetConnection): string | null;
}

// Raised when an adapter refuses to produce a descriptor because doing so would be unsafe
// (e.g. mongodump without --oplog on a replica set). Deterministic and credential-free.
export class EngineDescriptorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineDescriptorError";
    this.code = code;
  }
}
