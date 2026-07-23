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
}

export interface DumpScope {
  readonly databases: string[];
  readonly schemas: string[];
  readonly collections: string[];
}

// Facts discovered by the probe that change how a dump must be built.
export interface TargetFacts {
  readonly isReplicaSet: boolean;
  readonly hasMyisam: boolean;
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
  // Path to the artifact inside the executor (stream on stdin or a staged directory).
  readonly sourcePath?: string;
}

export interface VerifyInput {
  readonly connection: TargetConnection;
  readonly serverVersionNum: number;
  readonly scope: DumpScope;
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
