# @schrodump/engines

Per-engine descriptors and probes. Takes precedence over the root `CLAUDE.md` inside this
directory.

## Invariants

- Imports **only** `@schrodump/core` and the database drivers the probe uses (`pg`, `mysql2`,
  `mongodb`). **Never** imports `storage` or `runner`.
- Responsibility: say **what** to execute (descriptors). It **executes nothing** — the `runner`
  does that.
- **The golden rule:** adding an engine (MariaDB split out, anything future) is a **table entry**
  in `registry.ts`, never a new `if (engine === ...)` scattered around. The only per-engine
  dispatch is the `Record<EngineKind, EngineAdapter>` in the registry; `if`/`switch` on the engine
  belongs inside an adapter.

## Credentials

- **Never** in `command` — argv is visible to any process on the host. It goes in `env`
  (`PGPASSWORD`, `MYSQL_PWD`) or in a mounted config file (mongo, via `--config`).
- TLS is on by default; disabling it is an **explicit** option on the target, never a silent
  fallback. A connection timeout is mandatory in every probe.

## TLS — three modes, read once (`targetTlsOf`, `descriptor.ts`)

- `tls` + `tlsCaCert` on `TargetConnection`/`ProbeConnection` mean exactly one of: **disable**;
  **require** — encrypted, and for postgres and mysql/mariadb the certificate NOT verified (mongo's
  tools verify against the system store here, their default); **verify-full** — the chain against
  the target's CA and the host name checked. The probes and every adapter call `targetTlsOf`/
  `tlsModeOf` and nothing else, because the defect this replaced was the probe and the tools
  disagreeing: the probe verified against Node's bundled CAs, pg_dump verified nothing.
- **Descriptors never carry the PEM** — they name `TLS_CA_PATH` (`PGSSLROOTCERT`, `--ssl-ca`, `--ca`,
  `--sslCAFile`) and the composer mounts the file there, like `MONGO_CONFIG_PATH`. Named without the
  mount, the tool fails on a missing file: the right direction to fail in.
- The spellings are measured, not assumed (a descriptor test cannot tell a flag the tool lacks from
  one it has): libpq `PGSSLMODE=verify-full`; mysql `--ssl-mode=VERIFY_IDENTITY --ssl-ca`; mariadb
  `--ssl --ssl-ca --ssl-verify-server-cert` (it has no ssl-mode); mongo tools **`--ssl`** and
  `--sslCAFile` — `--tls` is an unknown option to database tools 100.x, and it is what this adapter
  emitted until TLS was actually run.
- **mydumper/myloader honour verify-full and not require**: `--ssl-mode=REQUIRED` falls back to
  plaintext when the server offers no TLS. `stagedTlsRefusal` says so before the server picks a mode,
  and the STAGED descriptors throw `MYSQL_STAGED_TLS_UNVERIFIED` rather than emit it.
- The probe drivers need their own care: mysql2 checks the host name only with `verifyIdentity`,
  and neither pg nor mysql2 hands tls.connect the host — for an IP-literal host Node checks the
  certificate against `localhost` (measured). `probePostgres` pins `checkServerIdentity` to the
  configured host; `probeMysql` checks the address after connecting (mysql2 allows no override).

## Probe — what is not obvious

- On MongoDB the `database` field of `ProbeConnection` is the **authSource** (`admin`), not the
  database to copy. Passing the scope there authenticates against the wrong database and fails
  with a correct credential.
- `probeMongodb` calls `listDatabases()`, and a **scoped** credential is what it wants. When the
  user lacks the cluster-wide `listDatabases` action, the server applies `authorizedDatabases: true`
  implicitly and answers with the databases that user can reach — it does **not** refuse. Measured
  against mongod 8.2.12: a user created in `admin` with `readWrite` (or plain `read`) on one
  database gets back exactly `["shop"]`, not `Unauthorized`.
  **What this scope is NOT is the dump's scope.** It used to be: `worker-wiring` fed `probe.scope`
  straight into `buildDump`, so an **admin** credential listing `admin`/`config`/`local` was refused
  with `MONGODB_SCOPE_TOO_BROAD`, and narrowing the credential was the remedy. Since `dumpScopeFor`
  the dump scope is the **target's**, and an empty one means the full instance — which is what a
  replica set requires and what made replica-set backup reachable at all. So for mongodb this probe
  scope is **discovery**: it tells the operator what is there, it does not decide what is copied.
  A least-privilege credential is still the right configuration, and `scripts/smoke-compose.sh`
  uses one — but it is least privilege now, not the mechanism that keeps the scope unambiguous.
- **`probePostgres` reports `canReadRolePasswords`, and `buildGlobalsDump` obeys it.** It is
  `has_table_privilege('pg_catalog.pg_authid', 'SELECT')` — the exact read `pg_dumpall` makes for
  password hashes unless given `--no-role-passwords`, and one only a superuser (or a role granted it)
  may make. `rolsuper` would be the wrong predicate. Before this fact existed every globals dump
  asked for passwords, so the first backup of every managed postgres (RDS, Cloud SQL, Azure,
  Supabase, Neon, ...) and of every least-privilege role failed with `permission denied for table
  pg_authid`. False, the globals go out with `--no-role-passwords` — roles, memberships and settings
  intact, no hashes. Decided before the run rather than by retrying on failure: one execution, no
  stderr to pattern-match in whatever language the server's `lc_messages` speaks, and the answer is
  known in time for the manifest to record it (`rolePasswordsCaptured`, `apps/server`).
  `adapters/postgres-globals.integration.test.ts` proves it against a real server, including the
  negative control that the same role asked for passwords is still refused.
- **Classifying a driver error is `apps/server`'s job** (`probe/test-connection.ts`), not this
  package's. The probe may propagate the raw error — the server translates it into a code without
  leaking the credential. Do not swallow or rewrite the error here.

## Staging descriptors (`staging.ts`)

`buildArchiveStaging` / `buildExtractStaging` bridge a directory dump (`pg_dump -Fd`, `mydumper`)
and the single-stream artifact pipeline. They are engine-independent on purpose and are
deliberately **not** a new executor image: `tar` already exists in every image the adapters
resolve, so the caller passes the image its own adapter picked. A dedicated tar image would add
another tag and another digest to pin, to run a command that is already there. Both descriptors
carry an **empty env** — neither step has any reason to travel with a target's password.

**A STAGED mysql/mariadb dump names exactly one database, or `buildDump` refuses it**
(`MYSQL_STAGED_REQUIRES_ONE_DATABASE`). `mydumper -B` copies one database by name, and the
descriptor used to read `-B connection.database` — for an unscoped target, `mysql`, the system
schema the connection opens through. The dump exited 0 over no user data, and a multi-database
scope kept only its first. `-B` now names `scope.databases[0]`, so what is checked is what is
dumped. The routing that keeps production away from the refusal lives in `apps/server`
(`resolveExecutionMode`'s `singleDatabaseStagingScope`); the refusal is for the caller that forgets.

## Executor images

- postgres: `postgres:<major>-alpine` (13–18); `pg_dump` must be ≥ the server version.
- mysql/mariadb: `mysql:<maj.min>` / `mariadb:<maj.min>`; STAGED uses `schrodump/mydumper` (ours).
- mongodb: the **official** `mongo:<major>` — verified to already ship `mongodump`/`mongorestore`.

The `schrodump/*` images referenced here by floating tag (`schrodump/mydumper:1`) are built with
the version **and digest** pinned in `docker/executors/` and published by the `executors` job in
`release.yml`. Changing the tag reference is application code, not infrastructure.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
