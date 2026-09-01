# @schrodump/server

Fastify + Prisma + PostgreSQL. Composes `@schrodump/core`, `engines`, `runner` and `storage` — the
only place where those four meet. Takes precedence over the root `CLAUDE.md` here.

## Structure

- `routes/` — HTTP. Every route validates with Zod and calls a store/service. `wiring.ts` builds
  the real stores (`scopedPrisma`), the `JobsService` and the encryption-key service.
- `jobs/` — the logic of each job (backup, verify, restore, retention, catalog-rebuild,
  self-backup) as functions, plus the `-wiring.ts` that binds them to Prisma/runner/storage.
  Retention is a `JobKind` (`RETENTION`), not a background sweep: deleting a backup is an outcome
  the operator has to be able to read afterwards — including when the cycle refused to run. It is
  chained by the worker after a **SUCCEEDED** BACKUP of the same policy (`jobs/worker.ts`), never
  by a cron of its own; a failed backup never costs an old copy.
- `scheduler/` — evaluates policies and creates jobs. It is a **system process**, not a tenant
  request: it reads policies cross-organization and writes `organizationId`-scoped jobs. Idempotent
  per `(policyId, scheduledAt)`; orphan recovery marks `RUNNING → FAILED` at boot. The worker
  (`jobs/claim.ts` + `jobs/worker-wiring.ts`) is the other system process with the same status.
- `crypto/` — the three crypto domains (below) plus key provisioning. `probe/` — real connection
  testing.
- `auth/` — better-auth (`auth.ts`) + RBAC (`rbac.ts`). `data/scope.ts` — `scopedPrisma`;
  `data/patch.ts` — the shared `PATCH` semantics.
- `notifications/` — a pure evaluator plus webhook and SMTP delivery (below).
- `observability/` — `pino.ts` (logging with redaction), `audit.ts` (the art. 37 trail, below) and
  `health.ts` (`GET /health`, below).
- `bootstrap/` — first-boot admin creation and the setup-token flow.

## Invariants

- **Every domain model carries `organizationId`.** No exceptions, internal routes included. Access
  is always through `scopedPrisma(orgId)` (a client extension that injects `organizationId`);
  forgetting the filter is impossible, not merely difficult. The exceptions are the system
  processes — the scheduler and the worker (`jobs/claim.ts`, `jobs/worker-wiring.ts`) — which use
  the raw client and filter `organizationId` explicitly in every query.
- **Every route input goes through Zod before Prisma.** The vector is an unvalidated object
  reaching a `where` clause — `express-mongo-sanitize` and friends do NOT protect Prisma.
- **A credential is write-only from the user's perspective.** It is never decrypted in order to be
  **displayed**. See the deliberate exception under "Probe": decrypting in order to **use** it is a
  different thing.
- **No secret in any log, at any level** (including `debug`). `observability/pino.ts` redacts
  `password`/`secret`/`secretAccessKey` (and `*.` variants); the convention reinforces it.
- A `viewer` **cannot** trigger a restore — an audit requirement. The route demands `operator+`;
  the UI hiding the button is the second lock, not the only one.
- **Retention never deletes by omission.** Every `keep*` counter defaults to 0 — in the Zod schema
  and in the column — so "I did not configure retention" and "I want to keep zero copies" arrive
  identically at `resolveRetention`, which answers the second: delete everything.
  `retentionIsConfigured` (core) is the mandatory guard before acting on that answer, and
  `runRetention` applies it before any I/O. Silence is not an instruction. The same rule covers an
  incomplete view: an unreadable or orphaned manifest aborts the whole cycle rather than pruning
  against a picture already known to be partial.

## Probe / test-connection (`probe/test-connection.ts`)

- **The only place that decrypts a target's credential** — and it decrypts in order to **use** it
  (hand it to a driver that opens a socket), never to display it. The clear text does not leave the
  function call; nothing derived from it enters the response or the log.
- **Classifies by the driver error's CODE, never by its message.** A driver error embeds the
  credential that failed (the Mongo driver puts the whole URI, password included, in the text).
  What comes out is one of the `ProbeFailureCode` constants. The single exception: when
  classification gives up (`UNKNOWN`), the result carries `driverCode` — class plus code only
  (`ERROR/18`), which cannot carry a secret — so that `UNKNOWN` is not a dead end.
- Reading the message to break a tie is allowed (the Mongo driver reports connection failure
  without a code); **emitting** the message is not. The distinction is commented in the file.
- `serverVersionNum` is an encoded integer (`major*10000 + minor*100 + patch`) — a comparison key,
  not text. Formatting it for display belongs to `apps/web`.

## Env (what the server actually reads)

`env.ts` validates with Zod. Beyond `DATABASE_URL`, `PORT`, `SCHRODUMP_KEK`, `SCHRODUMP_URL`,
`SCHRODUMP_ADMIN_EMAIL`/`SCHRODUMP_ADMIN_PASSWORD` (and `BETTER_AUTH_SECRET`/`LOG_LEVEL`), it reads
the worker/executor configuration: `SCHRODUMP_SCRATCH_PATH`, `SCHRODUMP_SCRATCH_MAX_BYTES`,
`SCHRODUMP_MAX_CONCURRENT_STAGED`, `SCHRODUMP_EXECUTOR_NETWORK`, `WORKER_POLL_MS`,
`SCHRODUMP_SCHEDULER_TICK_MS`, `SCHRODUMP_SHUTDOWN_GRACE_MS`,
`SCHRODUMP_STAGED_THRESHOLD_BYTES`, `SCHRODUMP_NOTIFY_MIN_GAP_MS`, `SCHRODUMP_TRUSTED_PROXIES`,
and the self-backup trio (`SCHRODUMP_SELF_BACKUP_DESTINATION_ID`, `_INTERVAL_MS`, `_NETWORK`).
An absent scratch path ⇒ STREAM-only (no staged/parallel).

> **`SCHRODUMP_ADMIN_EMAIL` is `z.email()` and `SCHRODUMP_ADMIN_PASSWORD` is `min(12)`,** the same
> floor as `minPasswordLength` in `auth.ts`. Validating it here means a too-short value is a legible
> boot failure that names the variable, instead of a Better-Auth error surfacing from wherever the
> bootstrap happened to be. Both are optional, but an empty string is an **invalid** value, not
> "unset", and it stops the boot — leave them absent to create the admin through the setup link.

> **`SCHRODUMP_STAGED_THRESHOLD_BYTES` has no default, and that is the decision.** STAGED is faster
> on a large database, but it writes the clear-text dump to disk before uploading and requires the
> scratch volume to be sized for it — so the mode is never chosen FOR the operator on the basis of
> size. `parallelism > 1` on the policy is the explicit, per-policy path. Before this was fixed the
> threshold defaulted to `SCHRODUMP_SCRATCH_MAX_BYTES`, which is the **volume ceiling**, not a
> routing threshold: the effect was to stage only dumps larger than the entire scratch budget.

> **`SCHRODUMP_TRUSTED_PROXIES` decides whether the login rate limit is real.** It is the
> comma-separated list of CIDRs for every hop in front of this server (the TLS-terminating reverse
> proxy, plus `127.0.0.1/32` for the shipped image's internal UI rewrite). Unset, nothing is
> trusted and the server warns at boot — because the alternative, trusting a forwarded header by
> default, buckets the limit on a value the attacker sets.

> **Note:** `DOCKER_HOST` does not go through `env.ts` — the runner (dockerode) reads it straight
> from the environment.

## Prisma

- **Prisma 6** (7 requires a driver adapter + `prisma.config.ts`; deferred). Generator
  `prisma-client-js`, client from `@prisma/client`.
- `prisma generate` runs in the `typecheck`/`test`/`build` scripts (it needs no database).
- Migrations reversible and reviewed before applying; `prisma migrate diff` clean. In production
  the image entrypoint runs `prisma migrate deploy` before the server listens.
- **BigInt and JSON:** Prisma returns `BigInt` for columns such as `sizeRawBytes` and
  `minAgeBeforeDeleteMs`. Fastify does not serialise `BigInt` by default, and `BigInt` arithmetic
  against `number` throws at runtime. Mapping before serialising (or before handing values to
  `core`) is mandatory: policies through `toPolicyRecord`, `GET /artifacts` through
  `toArtifactRecord` (`routes/wiring.ts`), retention through `toRetentionPolicy`
  (`jobs/worker-wiring.ts`).

## Cryptography (3 domains, do not mix them)

1. **Metadata credentials** — envelope: a DEK per credential, wrapped by the KEK
   (`SCHRODUMP_KEK`). Decryption in `crypto/envelope.ts`.
2. **KEK fingerprint** — SHA-256 of derived material (never the key), written to `AppConfig` on
   first boot; boot fails if it diverges. That is why swapping the KEK against an existing database
   refuses to boot rather than producing artifacts nobody can open.
3. **Artifacts** — `age` **in-process** through the `age-encryption` library (`Encrypter` on
   backup, `Decrypter` on restore; keygen from the same library), always 2 recipients (operational
   + escrow). There is **no `age` executor**: encrypting inside a container required stdin over a
   hijacked attach, whose demux corrupted the stream. Pipeline: dump → compression → encryption
   (never invert it). Both stream helpers live in `crypto/artifact.ts`.

## Audit trail (`observability/audit.ts`)

- **One `onResponse` hook, not a call per route.** The per-call-site approach is what produced the
  gap this replaced: `docs/lgpd.md` claimed a trail covering targets and destinations while the
  codebase emitted exactly one action, from the restore path. A per-route audit call is something a
  new route forgets, and a missing audit row is indistinguishable from an action that never
  happened. This hook cannot be forgotten — it covers routes that do not exist yet.
- **It records WHAT and WHO, never the payload.** Request bodies here carry database passwords and
  S3 secret keys; an audit trail that captured them would turn the compliance feature into the
  largest credential leak in the product. What is written: the action, `targetType`/`targetId`,
  the `correlationId` (the same id in `x-correlation-id` and every log line for that request), and
  `metadata` of method/route/status.
- **Only mutating requests that got past `authenticate` and answered < 400.** No auth context means
  nothing to attribute; a 4xx means nothing changed.
- **The action name is derived from the route PATTERN, never the concrete URL**, so an id can never
  land in it. Depluralisation has two rules (`-ies` → `y`, then trailing `-s`), which covers every
  route here — an irregular plural would come out wrong rather than fail, so keep route names
  regular.
- **A write failure is logged, never thrown.** The request has already been answered, so failing it
  is not an option; going quiet is not one either, which is the lesson of the file.
- **Known gap: `credential.read` is not recorded.** Decryption happens inside job execution across
  several call sites. That is written down in `docs/lgpd.md` rather than partially implemented.

## `GET /health` (`observability/health.ts`)

- **It asks PostgreSQL; it does not assert.** The endpoint used to return a hardcoded
  `{ status: "ok" }`, and the Dockerfile `HEALTHCHECK` polled it every 30s — so a deployment whose
  metadata database had gone away reported HEALTHY while every job failed. Being up was the only
  thing it ever checked, which is the exact reasoning this product rejects everywhere else.
- **It reports, it does not act.** Docker's `restart` policy reacts to a container *exiting*, not
  to health status, so an unhealthy container keeps running and the state is merely visible. That
  is the behaviour we want: killing the process because PostgreSQL blipped would abort an in-flight
  backup — and leave the cleartext scratch directory the shutdown handler would have removed.
- **The probe budget (`HEALTH_TIMEOUT_MS`, 2s) is below the Dockerfile's own 5s timeout**, so a
  wedged database is reported by us with a reason rather than by `wget` giving up with none. A test
  asserts that ordering, because the two numbers live in different files.
- **Failure is logged as a driver code, never as the driver's prose** (it reuses `driverCodeOf`
  from `probe/test-connection.ts`), and the 503 body names the dependency and nothing else. The
  route is unauthenticated, and a Prisma connection error spells out host, port and user.

## Notifications (`notifications/`)

- **The unit is the fleet, not the job.** Alert on every job and it is filtered within a week;
  alert only on failure and the worst case — jobs succeeding while nothing is verified — stays
  silent. `evaluate.ts` compares two fleet snapshots and emits three triggers: `ARTIFACT_FAILED`,
  `VERIFICATION_BEHIND`, `POLICY_QUIET`, each as `opened` or `resolved`.
- **`evaluate.ts` is pure**: a snapshot, the previous snapshot and what has already been delivered
  go in; notifications come out. No database, no clock, no delivery — all three belong to
  `wiring.ts`, and keeping them out is what makes every trigger *and every non-trigger* testable.
- **`SCHRODUMP_NOTIFY_MIN_GAP_MS` (default 15 min) is hysteresis, not throttling.** Every healthy
  backup is briefly `UNOBSERVED` between finishing and its chained verify, so a previous snapshot
  younger than this is treated as absent — otherwise "the count did not come down" fires on
  success.
- **Delivery reads committed state after the fact and is never in a job's path.** A notification
  that fails must never fail a backup. The last delivery failure is stored and shown in the UI: a
  notifier that stopped delivering is indistinguishable from a healthy one unless the interface
  says so.

## Self-backup (`jobs/self-backup*.ts`)

- **Sealed with the ESCROW key, and it refuses to run without an active one.** The **operational**
  key's identity lives, KEK-wrapped, **inside the database the dump saves** — in the disaster where
  a self-backup would be used, it is gone with it. An artifact sealed only to that key is a decoy:
  it looks like protection and nobody can open it. `selectSelfBackupRecipients` throws rather than
  write one.
- **`SUCCEEDED` is `UNOBSERVED`, and the UI paints it amber.** A `pg_dump` that exited 0 is a
  process that did not complain. Green here would be the one place in the product asserting that a
  backup is good because a job said so.
- **The executor joins the `internal` network, not `SCHRODUMP_EXECUTOR_NETWORK`.** The metadata
  database is deliberately unreachable from the network where executors that talk to customer
  databases run; this is the one dump that must cross the line, and it crosses for its duration
  only.
- **Due-ness is computed from the last `SUCCEEDED` run, never from a process timer.** A timer would
  reset on every restart, and a daily self-backup on a server redeployed hourly would never run.
- **Its own loop and advisory lock (`SCHRDMP3`).** A metadata dump takes minutes and `startLoop` is
  single-flight — folding it into the scheduler tick would stall dispatch for that whole time. The
  three locks are `SCHRDMP1` (worker), `SCHRDMP2` (scheduler) and `SCHRDMP3` (self-backup), defined
  in `server.ts`.
- **The recovery rehearsal runs in CI** (`self-backup-recovery.integration.test.ts`): a real
  `pg_dump` with the production descriptor → `encryptStream` to escrow only → `decryptStream` →
  `pg_restore` into an empty database → the organization comes back. It also asserts that the
  **operational identity cannot open it**. It is the only test in the project that takes an
  artifact out of `UNOBSERVED`. What it does not cover — the executor reaching the database over
  the internal network, and the round trip through the bucket — is covered by
  `self-backup-e2e.integration.test.ts`, which drives the scheduler's own tick against a real
  executor, a real network and a real bucket. Pointing the executor at the wrong network fails all
  four of its assertions; that was exactly the defect that would have shipped.
- **The row is created BEFORE the configuration is resolved.** A deleted destination or a missing
  escrow key becomes a `FAILED` `SelfBackup` with a legible reason, visible in `GET /self-backups`,
  not just a log line.

## Bootstrap-password rotation (`auth/rbac.ts`, `auth/auth.ts`)

- **`mustChangePassword` is enforced in `requireRole`, before the role check and for every role.**
  The question is not what the account may do — it is that the password authorising it is still the
  one from the environment, readable via `docker inspect`. It returns `403
  password_rotation_required`, a machine code rather than prose: the UI has to tell it apart from
  an ordinary permission denial.
- **`GET /me` stays outside the gate** (it uses `authenticate` only), otherwise the UI could not
  explain why it is blocked. Better-Auth's change-password endpoint lives under `/api/auth/*` and
  does not pass through here — without that, the gate would be a trap rather than a control.
- **The flag is cleared by a `hooks.after` on `/change-password`,** and only on a 2xx: a rejected
  change (wrong current password) leaves the requirement standing.
- **The resolver reads the flag from the `User` row, not from the session.** The session is minted
  at sign-in and would keep saying "rotation pending" for the rest of its life after the password
  had already been changed.

## Rate limiting (`auth/auth.ts`)

Better-Auth's rate limiting is configured explicitly rather than left to its defaults: `storage:
"database"` (the `RateLimit` model — in-memory counters reset on every restart and are per-process),
a global 100 requests / 10s, and `customRules` of 5 attempts per 300s on `/sign-in/email` and
`/sign-up/email`. Credential stuffing is a slow grind, so the window that matters is minutes, not
seconds. The bucket key depends on `advanced.ipAddress.trustedProxies` — see
`SCHRODUMP_TRUSTED_PROXIES` above.

## Lists are bounded, counters are not

- **`GET /jobs` and `GET /artifacts` return at most `LIST_PAGE_SIZE` (200) rows**, newest first,
  and send `total` alongside. Twenty daily policies with chained verify write ~40 job rows a day —
  ~15,000 a year — and the artifact table grows with whatever GFS retention keeps. An unbounded
  list endpoint degrades silently for a year and then stops serving.
- **`counts` comes from a `groupBy` over the whole table, NEVER from `items`.** The dashboard leads
  with "N unobserved backups"; deriving that number from a truncated page would under-report it —
  and that is the one number this product cannot round. Truncating the list is a rendering
  decision; truncating that counter would be a lie.
- **`countByState` was removed from `apps/web`, not merely left unused.** It existed to derive a
  counter from an array, which is now actively wrong.
- **The `take` lives in `wiring.ts`, and the route tests stub the whole service** — so
  `wiring.test.ts` asserts the query shape with a fake that goes through the real `scopedPrisma`
  wrapper, which incidentally proves the `organizationId` filter is still applied.

## Key provisioning (`routes/encryption-keys.ts`, `crypto/key-provisioning.ts`)

- **Until this existed, nothing in the product created an `EncryptionKey`.** `generateAgeKeyPair`
  was called only by tests and every production reference was a read — a fresh install failed its
  first backup inside `resolveRecipients` with no path to fix it through the interface.
- **The escrow identity is returned ONCE and is not persisted.** `encryptedIdentity` is null by
  construction. Storing it would mean losing the metadata database loses both keys at once and the
  self-backup could never be recovered — which is the entire reason it seals to escrow. Covered by
  a test asserting the written row contains no trace of it.
- **An operator-supplied recipient is validated by age itself** (`isValidAgeRecipient`), bech32
  checksum included: a transposed character is refused now, not discovered months later as an
  artifact nobody can open.
- **409, not 400, when an active key of that type already exists.** Two active operational keys
  would make `resolveRecipients`' `find` pick by row order — a decision nobody made. Rotation is a
  separate operation and does not exist yet.

## Bootstrap and the setup link (`bootstrap/`)

If `SCHRODUMP_ADMIN_EMAIL`/`_PASSWORD` are absent, the first boot mints a setup token: 32 random
bytes, **only the SHA-256 hash is persisted**, single-use, 60-minute TTL. The raw token exists in
the boot log line and in the operator's URL, nowhere else — so a leaked database does not hand over
an admin-creation link, and an old log line stops working after an hour.

## Known gaps (see `docs/roadmap.md`)

- **STAGED works in both directions, and three things had to land together.** The staging directory
  is now **mounted** into the dump container (previously `-Fd` wrote inside the container and died
  with it), a second run `tar`s that directory to stdout (`buildArchiveStaging`), and the restore
  unpacks before handing the directory to `pg_restore`/`myloader` (`buildExtractStaging`). Without
  any one of the three, a STAGED backup uploaded an **empty** artifact with the job `SUCCEEDED` —
  and since verify downgraded to CHECKSUM, which passes on the ~318 bytes of header, that empty
  artifact could reach `VERIFIED`. The `tar` comes from the engine's own image rather than a pinned
  executor: less supply-chain surface, at the cost of depending on busybox tar staying there.

- **Restore runs end to end for all four engines, in both execution modes:** the route enqueues,
  the worker dispatches `RESTORE` and runs the real pipeline (download → in-process decrypt →
  gunzip → mounted file → `pg_restore`/`mysql`/`mongorestore`). A `STAGED` artifact goes through
  one extra step first: the tar is unpacked into a sibling directory in scratch, and it is the
  **directory** that gets mounted — never the tar. What is missing: real sub-scope selection for
  mysql/mongo (today it is always a full restore), and mongo is limited to `FULL_CLUSTER` because
  `mongorestore` runs with `--drop` and without `--nsInclude`.

- **Mongo backup requires `SCHRODUMP_SCRATCH_PATH` to be configured** — the `mongodump`/
  `mongorestore` password travels only via a mounted `--config` file (never argv/env), and that file
  has to live at a path the Docker daemon can resolve (`RunMount.source`), i.e. the scratch volume.
  Without scratch configured, a mongo backup fails loudly and early
  (`MONGO_CONFIG_SCRATCH_REQUIRED_REASON` in `jobs/worker-wiring.ts`) instead of getting stuck deep
  inside the executor.

- **Resources are editable, with identity fields withheld.** `/targets`, `/destinations` and
  `/policies` have `PATCH` (operator+, `.strict()` and `.partial()` schemas, an empty patch is 400).
  What is **not** editable, and why — each would invalidate an existing artifact:
  `target.engine` (every artifact records the engine it was taken with), `destination.bucket`/
  `prefix` (artifact keys are relative to them; repointing leaves the whole catalog addressing an
  empty location), `policy.targetId`/`destinationId` (retention reasons per policy — repointing
  mixes two databases into one GFS chain and leaves the old destination's artifacts outside
  retention forever). Changing those means a new policy, not an edit.
- **Secrets stay write-only under `PATCH`.** Omitting `password`/`secretAccessKey` keeps the stored
  value — which is what makes it possible to edit a host or a region without resending a secret the
  UI can never read back.
- **`DELETE` refuses with 409 and a reason when something depends on the row**, and never cascades.
  A destination with artifacts is the sharp case: the row holds the only credential the system has
  for that bucket, and deleting it does not delete the backups — it makes them unreachable. A
  policy is the treacherous case: `BackupJob.policy` is an **optional** relation, so Prisma's
  default is `SetNull`, not `Restrict` — the database would accept it and null out `policyId` on
  every job it ever ran, leaving the artifacts unattributable and invisible to retention with
  nothing appearing broken. Hence the explicit check, and a message pointing at `enabled: false` as
  the right operation.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
