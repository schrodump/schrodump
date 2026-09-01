// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { EngineKind, RestoreTarget } from "./types.js";

// Declarative descriptor per engine and server-version range.
//
// `serverVersionRange` is expressed as an integer `major*10000 + minor*100 + patch`
// (this matches PostgreSQL's own `server_version_num`). `min` is inclusive; `max`
// null means "no upper bound in v1".
export interface EngineCapabilities {
  readonly engine: EngineKind;
  readonly serverVersionRange: { readonly min: number; readonly max: number | null };
  readonly supportedRestoreTargets: readonly RestoreTarget[];
  readonly maxParallelism: number;
  readonly streamCapable: boolean;
  readonly stagedCapable: boolean;
  readonly supportsPitr: boolean;
  readonly requiresSeparateGlobalsDump: boolean;
}

// The ONLY place in @schrodump/core that encodes per-engine differences.
// No other file may branch on EngineKind — record the fact here instead.
const CAPABILITY_MATRIX: Readonly<Record<EngineKind, EngineCapabilities>> = {
  postgres: {
    engine: "postgres",
    serverVersionRange: { min: 130000, max: null },
    supportedRestoreTargets: ["FULL_CLUSTER", "DATABASE", "SCHEMA", "TABLE"],
    // directory format (-Fd -j N) is the only parallel path and requires staging;
    // custom format (-Fc) is a single-threaded stream.
    maxParallelism: 8,
    streamCapable: true,
    stagedCapable: true,
    supportsPitr: false,
    // pg_dumpall --globals-only is not covered by pg_dump.
    requiresSeparateGlobalsDump: true,
  },
  mysql: {
    engine: "mysql",
    serverVersionRange: { min: 80000, max: null },
    supportedRestoreTargets: ["FULL_CLUSTER", "DATABASE", "TABLE"],
    // mysqldump is a single-threaded stream; mydumper is parallel and requires staging.
    maxParallelism: 8,
    streamCapable: true,
    stagedCapable: true,
    supportsPitr: false,
    requiresSeparateGlobalsDump: false,
  },
  mariadb: {
    engine: "mariadb",
    serverVersionRange: { min: 100600, max: null },
    supportedRestoreTargets: ["FULL_CLUSTER", "DATABASE", "TABLE"],
    // Same dump paths as mysql: single-threaded stream vs. parallel mydumper (staged).
    maxParallelism: 8,
    streamCapable: true,
    stagedCapable: true,
    supportsPitr: false,
    requiresSeparateGlobalsDump: false,
  },
  mongodb: {
    engine: "mongodb",
    serverVersionRange: { min: 60000, max: null },
    // FULL_CLUSTER only, and this is a safety gate rather than a missing feature. mongorestore is
    // driven with --drop and NO --nsInclude — buildRestore never reads input.scope — so a DATABASE
    // or COLLECTION restore would drop and overwrite EVERY namespace in the archive instead of the
    // one asked for. runRestoreJob validates the requested target against this list, so advertising
    // sub-scope here is precisely what made that reachable. They return together with --nsInclude
    // scoping; until then, refusing is the same call already made for STAGED restore.
    supportedRestoreTargets: ["FULL_CLUSTER"],
    // --archive is a stream, and parallelism stays at 1 until someone proves it is safe on top of
    // one. mongodump accepts --numParallelCollections alongside --archive, but "accepts" is not the
    // claim that matters: what has to be shown is that an archive written by parallel collection
    // workers restores completely, and the failure it would hide is a silently short archive —
    // exactly the class of defect this product exists to catch. Raising it is a feature, gated on
    // an integration test that dumps in parallel and asserts every collection came back, not on
    // reading the flag's documentation.
    maxParallelism: 1,
    streamCapable: true,
    stagedCapable: false,
    supportsPitr: false,
    requiresSeparateGlobalsDump: false,
  },
};

export function resolveCapabilities(
  engine: EngineKind,
  serverVersionNum: number,
): EngineCapabilities {
  const caps = CAPABILITY_MATRIX[engine];
  const { min, max } = caps.serverVersionRange;
  if (serverVersionNum < min || (max !== null && serverVersionNum > max)) {
    throw new RangeError(
      `Unsupported ${engine} server version ${serverVersionNum}; ` +
        `supported range is [${min}, ${max ?? "∞"}]`,
    );
  }
  return caps;
}
