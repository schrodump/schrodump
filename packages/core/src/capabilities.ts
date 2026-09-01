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
    // No TABLE. pg_restore can scope with -t, but buildRestore never emits it — it emits -n for
    // SCHEMA and nothing for TABLE, so a TABLE request ran --clean over the WHOLE dump and dropped
    // every table in the database to restore one. runRestoreJob validates against this list, which
    // made that reachable. Same withdrawal, and the same return condition, as mongo's: the flag,
    // plus an integration test proving a neighbouring table survives.
    supportedRestoreTargets: ["FULL_CLUSTER", "DATABASE", "SCHEMA"],
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
    // No TABLE: buildRestore emits no table-scoping flag at all, so a TABLE request restored the
    // whole dump — dropping and replacing every table in the database to write one of them.
    //
    // DATABASE stays, and the distinction is the artifact. buildRestore pipes the script into the
    // client with connection.database as the target, which scopes correctly for a single-database
    // dump (no USE statements in it). An artifact dumped with --databases — which buildDump emits
    // whenever the target names databases — carries CREATE DATABASE, USE and DROP TABLE for EVERY
    // database in it, and the client then writes into all of them regardless of which was asked
    // for. Measured on mysql 8.4.10, not inferred: two databases dumped together, a row added to
    // the second AFTER the dump, the script restored "into" the first — the second went from two
    // rows to one, the new row was gone, and the client exited 0.
    //
    // That hazard is a property of the ARTIFACT, which this per-engine table cannot see; it is
    // written down in docs/roadmap.md and surfaced to the operator instead of being encoded here.
    // TABLE comes back with a mechanism that provably filters and an integration test proving a
    // neighbouring table survives — `mysql --one-database` is not it, MySQL's own documentation
    // calls that rudimentary and based only on USE.
    supportedRestoreTargets: ["FULL_CLUSTER", "DATABASE"],
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
    // No TABLE: buildRestore emits no table-scoping flag at all, so a TABLE request restored the
    // whole dump — dropping and replacing every table in the database to write one of them.
    //
    // DATABASE stays, and the distinction is the artifact. buildRestore pipes the script into the
    // client with connection.database as the target, which scopes correctly for a single-database
    // dump (no USE statements in it). An artifact dumped with --databases — which buildDump emits
    // whenever the target names databases — carries CREATE DATABASE, USE and DROP TABLE for EVERY
    // database in it, and the client then writes into all of them regardless of which was asked
    // for. Measured on mysql 8.4.10, not inferred: two databases dumped together, a row added to
    // the second AFTER the dump, the script restored "into" the first — the second went from two
    // rows to one, the new row was gone, and the client exited 0.
    //
    // That hazard is a property of the ARTIFACT, which this per-engine table cannot see; it is
    // written down in docs/roadmap.md and surfaced to the operator instead of being encoded here.
    // TABLE comes back with a mechanism that provably filters and an integration test proving a
    // neighbouring table survives — `mysql --one-database` is not it, MySQL's own documentation
    // calls that rudimentary and based only on USE.
    supportedRestoreTargets: ["FULL_CLUSTER", "DATABASE"],
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
    // Sub-scope restore is back, under the condition it was withdrawn on: buildRestore now emits
    // --nsInclude for a DATABASE or COLLECTION target, which is what scopes --drop to the requested
    // namespace instead of the whole archive. Proven against a real mongod by
    // mongodb-restore-scope.integration.test.ts, which modifies a NEIGHBOUR after the dump and
    // asserts the modification survives the restore — removing --nsInclude turns that assertion red
    // with a document count of 1 where 2 was expected, which is the data loss this gate existed for.
    //
    // TABLE is absent because mongo has no such thing; COLLECTION is the equivalent, and the
    // descriptor refuses one that names no collection rather than widening to the database.
    supportedRestoreTargets: ["FULL_CLUSTER", "DATABASE", "COLLECTION"],
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
