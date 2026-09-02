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
- Probe: `tls: true` (require) by default; disabling TLS is an **explicit** option on the target,
  never a silent fallback. A connection timeout is mandatory in every probe.

## Probe — what is not obvious

- On MongoDB the `database` field of `ProbeConnection` is the **authSource** (`admin`), not the
  database to copy. Passing the scope there authenticates against the wrong database and fails
  with a correct credential.
- `probeMongodb` calls `listDatabases()`, and a **scoped** credential is what it wants. When the
  user lacks the cluster-wide `listDatabases` action, the server applies `authorizedDatabases: true`
  implicitly and answers with the databases that user can reach — it does **not** refuse. Measured
  against mongod 8.2.12: a user created in `admin` with `readWrite` (or plain `read`) on one
  database gets back exactly `["shop"]`, not `Unauthorized`.
  That is the behaviour the whole mongo scope design depends on, because the dump's scope comes
  from what this call returns: an **admin** credential lists `admin`/`config`/`local` too, and the
  backup then refuses with `MONGODB_SCOPE_TOO_BROAD` rather than guess which database was meant.
  So the narrow credential is the working configuration, not a compromise — and it is what
  `scripts/smoke-compose.sh` uses, so the remedy the error message prescribes is exercised rather
  than merely asserted.
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
