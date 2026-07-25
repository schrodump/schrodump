# MySQL/MariaDB + MongoDB STREAM restore + verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend restore + `FULL_RESTORE` verify to MySQL/MariaDB and MongoDB for STREAM artifacts, reusing the shipped staged-file restore + ephemeral-sandbox verify, and fix the MongoDB `--config` credential file that is referenced but never materialized (which also unblocks mongo backup).

**Architecture:** Gate restore/verify by `executionMode === STREAM` (any engine); add STREAM `buildRestore` + `buildVerifySandbox` for mysql/mariadb and mongo; materialize+mount the mongo `--config` file for the mongo executors; thread the artifact's origin database into the verify sandbox. STAGED (directory) stays refused/deferred.

**Tech Stack:** Node 22, TypeScript ESM (nodenext), Vitest, dockerode, Fastify, Prisma. See `docs/superpowers/specs/2026-07-24-mysql-mongo-stream-restore-verify-design.md`.

## Global Constraints

- **SPDX header** on every new/edited source file: `// SPDX-License-Identifier: AGPL-3.0-or-later` + `// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA`.
- **Dependency graph:** `engines`/`runner`/`storage` import ONLY `@schrodump/core`, never each other or `apps/*`. `apps/server` composes them.
- **No secret on argv** — passwords go via env (`MYSQL_PWD`) or a mounted config file (mongo). No secret in logs, the response, or `BackupJob.reason`.
- **Fail-loud restore:** a partial restore MUST exit non-zero (a good→SUCCEEDED on partial data is the thesis violation the postgres `--exit-on-error` closed). Verify the exact mechanism against the real client.
- **Thesis three-way verify** is unchanged: infra failure → INCONCLUSIVE (artifact stays UNOBSERVED), never FAILED.
- **Worker filters `organizationId` explicitly.** SPDX on new files. Integration tests gated by `SCHRODUMP_TEST_INTEGRATION`, skipped by default.
- Verify: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

---

### Task 1: `executionMode` on RestoreInput + the STREAM-only gate

**Files:**
- Modify: `packages/engines/src/descriptor.ts` (add `executionMode` to `RestoreInput`)
- Modify: `apps/server/src/jobs/restore.ts` (`ArtifactForRestore.executionMode` + gate), `apps/server/src/jobs/restore.test.ts`
- Modify: `apps/server/src/jobs/worker-wiring.ts` (load `executionMode`; `resolveVerifyPlan` signature), `apps/server/src/jobs/worker-wiring.test.ts`

**Interfaces:**
- Produces: `RestoreInput.executionMode: "STREAM" | "STAGED"`; `ArtifactForRestore.executionMode`; `resolveVerifyPlan(policyLevel, engine, executionMode)`.

- [ ] **Step 1: Failing gate tests (restore.test.ts).** Replace the postgres-only gate test. A STREAM mysql/mongodb artifact passes the gate (reaches the target-matrix check); a STAGED artifact of ANY engine (postgres included) is refused with `/STAGED restore is not available/i`, before any audit/decrypt (assert no audit, no runRestore). Add `executionMode` to the test `ARTIFACT` fixture.
- [ ] **Step 2: Run — verify fail.** `pnpm --filter @schrodump/server test restore`
- [ ] **Step 3: Implement the gate.** In `runRestoreJob` (restore.ts), replace the `artifact.engine !== "postgres"` block with: `if (artifact.executionMode !== "STREAM") return await fail(ports, "STAGED restore is not available in v1 (STREAM artifacts only)");`. Add `executionMode: "STREAM" | "STAGED"` to `ArtifactForRestore`.
- [ ] **Step 4: Thread executionMode through the wiring.** In `worker-wiring.ts`, add `executionMode` to the artifact `select`/load for the restore ports and pass it into `ArtifactForRestore`. Change `resolveVerifyPlan(policyLevel, engine)` → `resolveVerifyPlan(policyLevel, engine, executionMode)`: downgrade `FULL_RESTORE → CHECKSUM` when `executionMode === "STAGED"` (reason `"STAGED artifacts cannot be FULL_RESTORE-verified in v1: downgraded to CHECKSUM"`), else keep the level. Update the call site (pass `artifact.executionMode`). Update `RestoreInput` in descriptor.ts with `executionMode`.
- [ ] **Step 5: resolveVerifyPlan tests (worker-wiring.test.ts).** STREAM+FULL_RESTORE keeps it (any engine); STAGED+FULL_RESTORE downgrades; CHECKSUM/NONE unchanged. Update existing signature calls.
- [ ] **Step 6: Full server suite + typecheck + lint + engines typecheck** (RestoreInput change ripples to every `buildRestore` call — they must pass `executionMode`). Fix call sites (worker-wiring restore + verify build the RestoreInput). Expected green.
- [ ] **Step 7: Commit.** `feat(server): gate restore/verify by STREAM execution mode, not engine`.

---

### Task 2: MySQL/MariaDB `buildRestore` (STREAM, fail-loud)

**Files:**
- Modify: `packages/engines/src/adapters/mysql.ts`
- Test: `packages/engines/src/adapters/mysql.test.ts`

**Interfaces:**
- Consumes: `RestoreInput.executionMode` (Task 1).

- [ ] **Step 1: Verify the fail-loud mechanism.** Run `docker run --rm mysql:8 mysql --help 2>&1 | grep -i abort` (and the same for `mariadb`) to confirm whether `--abort-source-on-error` exists on the installed client. Record the result in the task report. If it exists → use option A; else → option B (see Step 3). This is a REQUIRED check — do not assume.
- [ ] **Step 2: Write the failing test** for the STREAM branch (assert whichever mechanism Step 1 confirmed). Example (option A): `buildRestore({..., executionMode: "STREAM", sourcePath: "/var/lib/schrodump/restore-source"})` → command contains `--abort-source-on-error`, connects to the db, references `source /var/lib/schrodump/restore-source`, no password on argv (password in `env.MYSQL_PWD`). Also a STAGED test: `executionMode: "STAGED"` → the existing `myloader -d <sourcePath>` command (unchanged).
- [ ] **Step 3: Implement.** Branch `buildRestore` on `input.executionMode`:
  - `STAGED` → the existing `myloader -B <db> -d <sourcePath>` (unchanged; unreachable while STAGED is gated, kept for the future).
  - `STREAM` with `sourcePath` → read the mounted mysqldump SQL file and fail on the first error. **Option A** (flag exists): `["mysql", ...connArgs, ...tlsArgs, "--abort-source-on-error", connection.database, "-e", "source " + sourcePath]`. **Option B** (no flag): `["sh", "-c", "exec mysql <interpolated connArgs/db> < '" + sourcePath + "'"]` where only non-secret host/user/db and our constant `sourcePath` are interpolated (password stays in `MYSQL_PWD` env); the batch-mode client exits non-zero on the first error. State in the code comment which option was chosen and why (cite the Step 1 check).
  - `outputKind: "directory"` (a mounted path, like postgres restore).
- [ ] **Step 4: Run engines test + typecheck + lint.** Green.
- [ ] **Step 5: Commit.** `feat(engines): restore mysql/mariadb STREAM artifacts, failing on the first error`.

---

### Task 3: MySQL/MariaDB `buildVerifySandbox`

**Files:**
- Modify: `packages/engines/src/descriptor.ts` (extend `buildVerifySandbox` signature with the origin database), `packages/engines/src/adapters/mysql.ts`, `packages/engines/src/adapters/postgres.ts` (accept the new param)
- Test: `packages/engines/src/adapters/mysql.test.ts`, `postgres.test.ts`

**Interfaces:**
- Produces: `buildVerifySandbox?(serverVersionNum: number, password: string, database: string): VerifySandbox`. postgres ignores `database` (keeps `"verify"`); mysql/mongo use it.

- [ ] **Step 1: Extend the signature.** In `descriptor.ts`, add `database: string` to `buildVerifySandbox`. Update `postgresAdapter.buildVerifySandbox` to accept (and ignore) it — postgres keeps `POSTGRES_DB: "verify"`, `database: "verify"` (a `-Fc` dump is db-name-agnostic). Update the existing postgres test call.
- [ ] **Step 2: Write the failing mysql test.** `mysqlAdapter.buildVerifySandbox(80000, "pw", "shop")` → image `mysql:8.0`, `env.MYSQL_ROOT_PASSWORD === "pw"`, `env.MYSQL_DATABASE === "shop"`, `readinessCommand` forces TCP (`["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]`), `username: "root"`, `database: "shop"`, `port: 3306`, `password: "pw"`. Same for `mariadbAdapter`.
- [ ] **Step 3: Implement `buildVerifySandbox` on mysql/mariadb adapters** (reuse `imageFor`; `port: 3306`). MYSQL_DATABASE pre-creates the origin db so a single-db mysqldump (no `CREATE DATABASE`) restores. Readiness forces TCP (`-h 127.0.0.1`) — the mysql entrypoint runs a socket-only bootstrap server first.
- [ ] **Step 4: engines test + typecheck + lint.** Green.
- [ ] **Step 5: Commit.** `feat(engines): describe the mysql/mariadb verify sandbox`.

---

### Task 4: MongoDB `--config` materialization + mount (fixes mongo backup)

**Files:**
- Create: `apps/server/src/crypto/mongo-config.ts` (or a suitable home) — a helper that writes the config + returns a `RunMount`
- Modify: `apps/server/src/jobs/backup-wiring.ts` (mount the config for mongodump), `apps/server/src/jobs/restore-executor.ts` and/or `worker-wiring.ts` (mount for mongorestore)
- Test: a unit test for the config-content helper

**Interfaces:**
- Produces: a helper `writeMongoConfig(dir, password): Promise<{ mount: RunMount; cleanup: () => Promise<void> }>` (or equivalent) that writes `password: <pw>\n` to a `0600` file and returns a `RunMount { source, target: MONGO_CONFIG_PATH, readOnly: true }`. `MONGO_CONFIG_PATH` is exported from `mongodb.ts` — import it (do not hardcode).

- [ ] **Step 1: Confirm the config format.** `mongodump`/`mongorestore` `--config` reads a YAML with a `password:` key (keeps the password off argv). Confirm the exact key the installed tools expect (`docker run --rm mongo:8 mongodump --help | grep -A2 config`) and record it. Write the file accordingly.
- [ ] **Step 2: Failing unit test for the content helper** — writes a file whose content is `password: <pw>` (exact format from Step 1), mode `0600`, and returns a `RunMount` targeting the imported `MONGO_CONFIG_PATH`, `readOnly: true`.
- [ ] **Step 3: Implement the helper** (mirror the identity-file write in `restore-executor.ts`: `writeFile(path, content, { mode: 0o600 })` + `chmod`). Return the mount + a cleanup that removes the file.
- [ ] **Step 4: Wire it into the mongo executors.** Only for the mongo engine: in the dump path (`backup-wiring`/its caller) and the restore path, when the engine is mongodb, materialize the config and pass its `RunMount` in the `mounts` array of the `runner.run(...)` for mongodump/mongorestore (today `mounts: []`). Reserve the config on the scratch volume (it carries the password) and clean it up in `finally`. Keep non-mongo engines' `mounts` unchanged.
- [ ] **Step 5: Server test + typecheck + lint.** The mount wiring is exercised by the smoke (Task 8); the content helper is unit-tested here. Green.
- [ ] **Step 6: Commit.** `fix(server): materialize and mount the mongo --config credential file`.

---

### Task 5: MongoDB `buildRestore` (STREAM)

**Files:**
- Modify: `packages/engines/src/adapters/mongodb.ts`
- Test: `packages/engines/src/adapters/mongodb.test.ts`

- [ ] **Step 1: Failing test.** `buildRestore({..., executionMode: "STREAM", sourcePath: "/var/lib/schrodump/restore-source", target: "DATABASE"})` → command is `mongorestore <mongoConnArgs> --config <MONGO_CONFIG_PATH> [--tls] --drop --archive=/var/lib/schrodump/restore-source`; `--oplogReplay` present only for `FULL_CLUSTER`; no password on argv; `env` from `mongoEnv`.
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Implement.** `--archive=${sourcePath}` (reads the mounted archive), add `--drop` (mirror `--clean`; harmless on a fresh sandbox). Keep `--config`, `--tls`, and the `--oplogReplay` (FULL_CLUSTER) logic. mongorestore exits non-zero on failure (fail-loud, verified in the smoke).
- [ ] **Step 4: engines test + typecheck + lint.** Green.
- [ ] **Step 5: Commit.** `feat(engines): restore mongodb STREAM archives from a mounted file`.

---

### Task 6: MongoDB `buildVerifySandbox`

**Files:**
- Modify: `packages/engines/src/adapters/mongodb.ts`
- Test: `packages/engines/src/adapters/mongodb.test.ts`

- [ ] **Step 1: Failing test.** `mongodbAdapter.buildVerifySandbox(80000, "pw", "shop")` → image `mongo:8`, `env.MONGO_INITDB_ROOT_USERNAME === "verify"`, `env.MONGO_INITDB_ROOT_PASSWORD === "pw"`, `readinessCommand` forces TCP via `mongosh --host 127.0.0.1 --quiet --eval` a ping, `username: "verify"`, `password: "pw"`, `database: "shop"`, `port: 27017`. No password on argv beyond the throwaway sandbox one (acceptable; it's the sandbox root pw, isolated + ephemeral) — prefer env where the tool allows.
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Implement** (reuse `imageFor`; `port: 27017`; authSource `admin`). Readiness forces TCP. The connection returned carries `username: "verify"`, `password`, `database: <origin>` — the assertion (`buildVerifyAssertions`) and the sandbox mongorestore use it; the mongo `--config` mount (Task 4) carries the password for mongorestore, and the assertion reads `MONGODB_PASSWORD` env.
- [ ] **Step 4: engines test + typecheck + lint.** Green.
- [ ] **Step 5: Commit.** `feat(engines): describe the mongodb verify sandbox`.

---

### Task 7: Verify wiring — origin database + per-engine sandbox + mongo config

**Files:**
- Modify: `apps/server/src/jobs/worker-wiring.ts` (`runFullRestore`)
- Test: covered by Task 8's smoke; add a focused unit test only where a pure helper is extracted.

**Interfaces:**
- Consumes: `buildVerifySandbox(…, database)` (Task 3/6), the mongo config helper (Task 4), the mysql/mongo `buildRestore` (Task 2/5).

- [ ] **Step 1: Resolve the origin database.** In `runFullRestore`, resolve the artifact's origin database name from the producing target's scope (the first scoped database, else the engine default the backup used). Pass it as the third arg to `adapter.buildVerifySandbox(serverVersionNum, sandboxPassword, originDb)`.
- [ ] **Step 2: Build the sandbox connection with the origin db + engine creds.** For mysql: `{ host, port: sandbox.port, username: "root", password: sandboxPassword, database: originDb, tls: false }`. For mongo: `{ host, port: sandbox.port, username: "verify", password: sandboxPassword, database: originDb, tls: false }`. postgres unchanged.
- [ ] **Step 3: Mount the mongo config for the sandbox restore.** When the engine is mongodb, materialize the config (Task 4 helper) with the sandbox password and include its `RunMount` in the restore descriptor's run (the `runRestorePipeline` restore step needs the mount). Ensure the mount reaches the mongorestore executor and is cleaned up. (mysql/postgres need no such mount.)
- [ ] **Step 4: Keep the total-catch guarantee.** All of the above stays inside `runFullRestore`'s single try → `classifyVerifyError`; a materialization/mount error → INCONCLUSIVE, never FAILED.
- [ ] **Step 5: Server suite + typecheck + lint.** Green (the full path is smoke-verified in Task 8).
- [ ] **Step 6: Commit.** `feat(server): wire mysql/mongo FULL_RESTORE verify sandboxes`.

---

### Task 8: Integration smoke (mysql + mongo) + docs

**Files:**
- Create/extend: an integration test (gated by `SCHRODUMP_TEST_INTEGRATION`) exercising mysql and mongo backup → restore → verify.
- Modify: `docs/roadmap.md`, `apps/server/CLAUDE.md`.

- [ ] **Step 1: Provision dev targets.** The smoke needs a running MySQL and a MongoDB target (mirror the postgres target setup). Document the prerequisites in the test/report (image, port, seeded database with ≥1 table/collection).
- [ ] **Step 2: Write the gated smoke.** For each of mysql and mongodb: back up a seeded database (this is the FIRST end-to-end exercise of mongo dump via the now-mounted `--config`), restore the artifact into a fresh target/db, and FULL_RESTORE-verify it → `VERIFIED`, sandbox container gone. Add a bad-artifact → `FAILED` and a bad-sandbox-image → `INCONCLUSIVE` case per engine. No credentials in assertions.
- [ ] **Step 3: Confirm skipped in unit mode.** `pnpm --filter @schrodump/server test` — the new cases skip by default.
- [ ] **Step 4: Docs.** In `docs/roadmap.md`, update the restore/verify limitation: STREAM restore+verify now works for postgres/mysql/mariadb/mongodb; STAGED (directory) is the remaining deferred item. In `apps/server/CLAUDE.md`, update the restore/verify note (no longer postgres-only for STREAM).
- [ ] **Step 5: Full workspace verify.** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Green.
- [ ] **Step 6: Commit.** `test(server): mysql/mongo STREAM restore+verify smoke + docs`.

> **If mongo backup does not actually produce a valid artifact even after Task 4** (the `--config`/tooling behaves differently than expected), Task 8 surfaces it: report BLOCKED with the exact mongodump error rather than shipping an unverified mongo path — the controller escalates (likely deferring mongo to a follow-up while mysql lands).

## Manual verification (dev smoke)

After Tasks 2-7, with the dev worker rebuilt and a mysql + mongo target configured: trigger a backup, then a restore, then a FULL_RESTORE verify for each engine; confirm the artifact flips to `VERIFIED`, the ephemeral sandbox is created and destroyed, and a corrupt artifact yields `FAILED` while a broken sandbox yields `INCONCLUSIVE` (artifact stays `UNOBSERVED`).
