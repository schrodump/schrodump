# MySQL/MariaDB + MongoDB STREAM restore + verify — design

- **Date:** 2026-07-24
- **Status:** approved, ready for implementation plan
- **Scope:** extend restore + `FULL_RESTORE` verify to MySQL/MariaDB and MongoDB for **STREAM**
  artifacts (mysqldump / mongodump `--archive`), reusing the shipped staged-file restore pipeline and
  the ephemeral-sandbox verify. STAGED (directory: mydumper, postgres `-Fd`) is refused loud and
  deferred to a separate staged-directory project.

## What the shipped code already gives us (do not rebuild)

- **Staged-file restore** (`restore-executor.ts`): S3 → in-process age-decrypt → gunzip → a single
  mounted file at `RESTORE_DUMP_PATH` → the engine's `buildRestore(sourcePath)` executor. Typed
  errors (`RESTORE_SOURCE_FAILED`/`RESTORE_DECRYPT_FAILED`/`RESTORE_EXECUTOR_FAILED`/`RESTORE_WRITE_FAILED`).
- **Ephemeral-sandbox verify** (`runFullRestore` + `withEphemeralService` + `classifyVerifyError` +
  the three-way `VerifyProof`): spins up a throwaway DB of the artifact's version, restores into it,
  runs `buildVerifyAssertions`, destroys it; infra failure → INCONCLUSIVE (artifact stays UNOBSERVED).
- **All four engine adapters** are wired (`registry.ts`); backup works for every engine.
- **`buildVerifyAssertions` exists for all three engine families** (postgres/mysql/mongo).
- **`buildVerifySandbox` exists for postgres only.**

The single-file staged model fits any **single-stream** artifact. It does NOT fit a **directory**
artifact (mydumper, postgres `-Fd`) — that needs a separate untar→mount-directory pipeline, out of
scope here (and the reason the gate below is by execution mode, not engine).

## The gate: STREAM-only, by execution mode

`restore.ts`'s `runRestoreJob` currently refuses `engine !== "postgres"`. Replace that with a check
on the artifact's **`executionMode`**:

- `executionMode === "STREAM"` → allowed for any engine that implements `buildRestore` (all four do).
- `executionMode === "STAGED"` (any engine, **including postgres**) → refuse loud: `"STAGED restore
  is not available in v1 (STREAM artifacts only)"`. This also closes a latent gap — a postgres `-Fd`
  artifact reaches the single-file pipeline today and fails confusingly; now it fails clearly.

`ArtifactForRestore` (restore.ts) gains `executionMode: "STREAM" | "STAGED"`; `worker-wiring`'s
restore assembly loads it. The engine target-matrix check (`supportedRestoreTargets`) is unchanged.

`resolveVerifyPlan` (worker-wiring): today it downgrades `FULL_RESTORE → CHECKSUM` for non-postgres.
Change it to downgrade for **STAGED** artifacts (any engine) — a STAGED artifact cannot be
FULL_RESTORE-verified because it cannot be restored yet. STREAM of any engine keeps FULL_RESTORE.
Thread `executionMode` into the plan input alongside `engine`. The **sealed** downgrade (domain) is
unchanged.

## Restore descriptors (STREAM)

### MySQL / MariaDB — `buildRestore` (`packages/engines/src/adapters/mysql.ts`)

When `sourcePath` is set (the mounted mysqldump SQL file), read the SQL and **fail on the first
error** (thesis-critical: without fail-loud the `mysql` client keeps going past a failed statement
and can exit 0, so a partially-restored dump would report SUCCEEDED — the hole `--exit-on-error`
closed for postgres). The exact mechanism is **verified during implementation** against the real
client, in this order of preference:

1. `mysql <connArgs> <tlsArgs> <database> --init-command=… -e "source <sourcePath>"` with the client's
   abort-on-error flag **if it exists** (candidate: `--abort-source-on-error`, present in recent
   MySQL/MariaDB clients — confirm the exact name/availability before relying on it).
2. Fallback if no such flag: `sh -c 'exec mysql <connArgs> <database> < <sourcePath>'` — the mysql
   client in non-interactive (batch) mode **exits non-zero on the first error by default** (no
   `--force`). Credentials stay in env (`MYSQL_PWD`), never argv; the only interpolated values are the
   non-secret host/user/db, and `sourcePath` is our own constant mount path — no target-controlled
   free text enters the shell string. The plan states exactly which values are interpolated.

Either way, a first error → non-zero exit → `RESTORE_EXECUTOR_FAILED` → FAILED. The implementer picks
the mechanism the installed client actually supports and records the check in the task report.
- `<database>` is the artifact's origin database; mysqldump `--databases` embeds `CREATE DATABASE IF
  NOT EXISTS` + `USE <origin>`, and mysqldump emits `DROP TABLE IF EXISTS` before each table, so a
  restore over existing data replaces cleanly (mirrors postgres `--clean`).
- The existing `sourcePath → myloader -d <dir>` branch is the STAGED (mydumper directory) path; it is
  now unreachable (STAGED is gated off) and stays untouched for the future staged-directory project.
  `buildRestore` distinguishes the two by a new signal — see "One open decision" below.

MySQL/MariaDB have no separate globals object (`requiresSeparateGlobalsDump` is false), so restore is
a single step.

### MongoDB — `buildRestore` (`packages/engines/src/adapters/mongodb.ts`)

```
mongorestore <mongoConnArgs> --config <MONGO_CONFIG_PATH> [--tls] --drop --archive=<sourcePath> [--oplogReplay if FULL_CLUSTER]
```

- `--archive=<sourcePath>` reads the mounted mongodump archive file (replaces the removed stdin
  `--archive`). `--drop` drops each collection before restoring it (mirrors `--clean`; harmless on a
  fresh verify sandbox). `mongorestore` exits non-zero on a failed restore (fail-loud).
- mongorestore restores into the **database names embedded in the archive** (the origin db), not a
  target-named db — this drives the sandbox/assertion database below.

## Verify sandboxes — `buildVerifySandbox` for mysql/mariadb + mongo

The postgres sandbox uses a fixed `verify` database because `pg_restore` is database-name-agnostic.
MySQL and MongoDB restore into the **origin database name** (mysqldump `USE <origin>` / the archive's
db names), so their sandbox and assertion must use the **artifact's origin database**, not `verify`.
`buildVerifySandbox` therefore takes the origin database name for these engines (postgres ignores it).
`runFullRestore` resolves the origin database from the artifact's producing target's scope.

### MySQL / MariaDB
- Image `mysql:<maj.min>` / `mariadb:<maj.min>` (`imageFor`).
- Env: `MYSQL_ROOT_PASSWORD=<random>`, `MYSQL_DATABASE=<origin db>` (pre-creates the origin db so the
  single-db mysqldump form — which lacks `CREATE DATABASE` — also restores).
- Readiness: `mysqladmin ping -h 127.0.0.1 --silent` — **force TCP** (the same lesson as the postgres
  `pg_isready -h 127.0.0.1` fix: the mysql entrypoint's bootstrap runs a socket-only server first, so
  a socket ping false-positives). Connection: `{ username: "root", password, database: <origin>, tls: false }`.

### MongoDB — **with root auth** (correction to the brainstorming "no auth")
The existing `buildVerifyAssertions` builds a `mongodb://user:pass@host/?authSource=…` URI, so the
sandbox needs credentials, and `mongorestore` must authenticate. Run the sandbox with the official
image's root bootstrap:
- Image `mongo:<major>` (`imageFor`).
- Env: `MONGO_INITDB_ROOT_USERNAME=verify`, `MONGO_INITDB_ROOT_PASSWORD=<random>`.
- Readiness: `mongosh --host 127.0.0.1 --quiet --eval <ping>` — **force TCP**. Credentials never sit
  on argv: `mongodump`/`mongorestore` take the password from `--config <MONGO_CONFIG_PATH>`; the
  `mongosh` assertion takes it from `MONGODB_PASSWORD` env (already coded in `buildVerifyAssertions`).

> **Gap this project must fix (discovered during planning): the mongo `--config` file is never
> materialized or mounted by anything.** The descriptors reference `/etc/schrodump/mongodb.yaml`, but
> `backup-wiring`/`worker-wiring` run every executor with `mounts: []`, and no code writes the file —
> so **mongo backup itself is not wired end-to-end** (mongodump would read a missing config). This
> plan adds a helper that writes the config (a `0600` scratch file containing `password: <pw>`) and a
> `RunMount` at `MONGO_CONFIG_PATH`, wired into the mongo executors for **backup** (mongodump),
> **restore** (mongorestore), and the **verify sandbox** restore. MySQL has no such gap — it passes
> the password via `MYSQL_PWD` env. Fixing mongo backup is therefore a prerequisite inside this
> project, and the smoke is the first end-to-end exercise of the mongo dump/restore path.
- Connection for restore + assertion: `{ username: "verify", password, host, port, database: <origin>,
  tls: false }`, authSource `admin`.

## Assertions (already exist; confirm they fire against the restored db)

- **MySQL** (`buildVerifyAssertions`): `mysql <db> -N -e "SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE()"` — connects to `connection.database` (the origin db) and counts
  user tables. Reused as-is; `connection.database` = origin db.
- **MongoDB** (`buildVerifyAssertions`): a STATIC mongosh eval script (no injection) that prints
  `getDB(<db>).getCollectionNames().length` for `SCHRODUMP_MONGO_DB` (= scope's first db, else
  `connection.database`). Reused as-is; the sandbox connection carries the origin db + the root creds.
- The `runFullRestore` count-parse (`exitCode === 0 && count >= 1`) is engine-agnostic. `VERIFIED`
  iff the restored origin db has ≥ 1 table/collection.

## One open decision for the plan: how `buildRestore` knows STREAM vs STAGED

`buildRestore` must emit the `mysql`/`mongorestore` STREAM command (mounted single file), not the
mydumper-directory command. Two options, decide in the plan:

1. **The gate guarantees STREAM** (recommended): since restore is gated to `executionMode === STREAM`,
   a `sourcePath` for mysql always means "a mounted SQL file" → the mysql-client branch. Add an
   `executionMode` field to `RestoreInput` and branch on it inside `buildRestore` (STREAM → mysql
   client; STAGED → the existing myloader path, currently unreachable). Explicit and future-proof.
2. Keep `sourcePath` meaning "SQL file" and treat the myloader branch as removed until the
   staged-directory project. Simpler diff, but conflates the two modes on one field.

Recommendation: option 1 — thread `executionMode` into `RestoreInput` so the descriptor is honest
about which artifact shape it's reading.

## Testing

- **Unit:** `buildRestore` (mysql STREAM emits `--abort-source-on-error` + `source`; mongo emits
  `--archive=<path> --drop`); `buildVerifySandbox` (mysql/mariadb env + TCP readiness; mongo root-auth
  env + TCP readiness); the STREAM-only gate in `runRestoreJob` (STREAM allowed for mysql/mongo;
  STAGED refused for every engine incl. postgres) + `resolveVerifyPlan` (STAGED downgrades, STREAM
  keeps FULL_RESTORE); the mysql/mongo three-way verify outcomes reuse the existing `runVerifyJob`.
- **Integration/smoke (gated by `SCHRODUMP_TEST_INTEGRATION`):** back up → restore → FULL_RESTORE
  verify a real MySQL artifact and a real MongoDB artifact end-to-end (VERIFIED happy path + a bad
  artifact → FAILED + a bad sandbox image → INCONCLUSIVE). Requires MySQL and MongoDB dev/CI targets
  alongside the existing postgres one.

## Follow-ups (out of scope)

1. **STAGED (directory) restore + verify** for mydumper and postgres `-Fd` — a staged-directory
   pipeline (untar the artifact → mount the directory → `myloader -d` / `pg_restore -Fd`), cross-engine.
2. Count-based assertion (record expected counts at backup, compare on verify) — cross-engine.
3. MongoDB restore of sharded/multi-db archives beyond the single origin db.
