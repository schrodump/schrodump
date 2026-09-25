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
  - **Every cron is read through `scheduler/cron.ts`, on the instance zone (`SCHRODUMP_TZ`).** The
    policy route validates with it (400 on `cron`, create and PATCH), the scheduler takes windows
    from it, the notification cadence is measured with it, and `GET /policies` answers `nextRunAt`
    from it. Before, the route accepted any non-empty string and nothing passed a zone: a stored
    `0 0 30 2 *` threw inside every tick, and every cron ran on the container's UTC while the UI
    read it on the viewer's clock (a São Paulo `0 2 * * *` ran at 23:00 their time). The grammar is
    the UI's five fields — a seconds field can name a new window every second, a new job per tick.
    `canEverFire` refuses a day of month no listed month has (cron-parser only checks the
    one-month case, and for `0 0 31 4,6 *` hands back a 1962 window instead of throwing), and `H`
    is seeded by the expression (unseeded it is random per parse — a new window every tick).
  - **Each policy is its own attempt, and so is each pass of the tick.** `dispatchDueJobs` catches,
    logs `policyId` + reason once per tick, and moves on; the tick's passes (dispatch, fleet
    notifications, job events) run through `runTickPasses` (`scheduler/tick.ts`). One unreadable
    cron used to stop every policy listed after it and — because the notification passes were
    awaited after dispatch in the same callback — every notification too. A stored policy the
    scheduler cannot read is measured at the one-minute cadence floor by the notification pass, so
    POLICY_QUIET says it has stopped producing backups instead of the pass throwing.
- `crypto/` — the three crypto domains (below) plus key provisioning. `probe/` — real connection
  testing. `egress/` — the one guard every outbound connection to an operator-supplied address
  passes through (below).
- `auth/` — better-auth (`auth.ts`) + RBAC (`rbac.ts`). `data/scope.ts` — `scopedPrisma`;
  `data/patch.ts` — the shared `PATCH` semantics.
- `notifications/` — a pure evaluator, webhook and SMTP delivery, and the job-event outbox drain (below).
- `observability/` — `pino.ts` (logging with redaction), `audit.ts` (the art. 37 trail, below) and
  `health.ts` (`GET /health`, below).
- `bootstrap/` — first-boot admin creation and the setup-token flow.
- `security-headers.ts` — `@fastify/helmet`, registered first in `buildApp` so a 401 from the RBAC
  hook and a 404 carry the headers too. The API answers JSON and nothing else, so its policy is
  `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, with
  `X-Frame-Options: DENY` (not helmet's SAMEORIGIN) and **no HSTS** — this process listens on plain
  HTTP and the operator terminates TLS in front of it (`docs/install.md`). The UI's own, richer
  policy lives in `apps/web/next.config.ts`, whose `headers()` skips the proxied prefixes so no
  response ends up carrying both.

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
- **Retention never deletes the policy's newest `VERIFIED` artifact.** Chaining off a SUCCEEDED
  backup protects old copies from a backup that *failed*; it says nothing about one that landed
  and then failed its verify. `resolveRetention` ranks by `createdAt` and cannot see verification
  state (it lives on the `Artifact` row, not in the manifest), so a run of FAILED verifies used to
  fill `keepLast` and push the last copy that restores into the delete-set — reported as an
  ordinary "kept 7, deleted 1". `runRetention` now asks `RetentionPorts.newestVerifiedJobId` (an
  organization-scoped query in `worker-wiring.ts`) and passes it to the resolver as `alwaysKeep`;
  when the window alone would have deleted it, `retentionSummary` names it in the job's reason.
- **There is ONE key builder, and retention deletes the key the ROW records.** Every object a
  backup writes goes through `objectKey` in `@schrodump/storage/manifest-sidecar`, never a template
  literal. It used to be both: `createBackupPorts` interpolated `${prefix}/${org}/${job}/${name}`
  while the manifest and every delete used the builder — which strips surrounding slashes. The two
  agree for every prefix except the one the destination form supplies by default, `""`, where the
  literal writes `/<org>/<job>/artifact.bin` and the builder computes `<org>/<job>/artifact.bin`.
  Those are different S3 keys. So the manifest was deletable and the artifact was not: retention
  removed the sidecar and the row, reported "kept 7, deleted 1", and left `artifact.bin` and
  `globals.bin` in the bucket permanently — storage outside the configured window, holding the role
  password hashes `pg_dumpall --globals-only` writes. Observed on a real instance, where one
  `Artifact` row carried `bucketKey = "/cmtq…"` beside `manifestKey = "cmtq…"`. The shared builder
  stops new ones; `RetentionPorts.recordedKeys` reclaims the old ones, because only the row knows
  where an artifact written by an earlier version actually went. Both spellings are passed to
  `delete` — `DeleteObjects` treats an absent key as a successful delete, so naming one that was
  never written costs nothing and naming the one that was is the entire point.
- **Nothing survives the process that made it.** Every removal in this codebase is in a `finally`,
  which covers a job that crashed and not a PROCESS that was SIGKILLed — an OOM, a host crash,
  `docker kill`. That left the executor or the verify sandbox running on the executor network,
  holding the anonymous volume that for a FULL_RESTORE verify IS the restored database in clear, and
  the job's scratch directory on disk with the dump in clear. `ScratchManager.gc()` had **no
  caller** while `docs/security.md`, `shutdown.ts` and `entrypoint.sh` all assumed it ran.
  `sweepAbandonedWith` is now called at boot and hourly from `server.ts`, **under the worker's
  advisory lock** — a running container may belong to a live replica mid rolling-restart, and
  reaping it would abort a backup nobody asked to abort. Containers carry `MANAGED_LABEL`, so the
  sweep can never touch one the operator started; `gc()`'s 24h age ceiling is the second guard, far
  longer than any executor timeout. The two halves run in separate `try`s because they fail for
  unrelated reasons, and the first to throw must not cancel the other. Step 1 of the compose smoke
  plants an old directory and a fresh one and asserts exactly one survives — no unit test reaches
  the boot sequence that wires this.
- **A verify that could not run is `INCONCLUSIVE`, not `FAILED`.** `FAILED` is a process that ran
  and broke; `INCONCLUSIVE` is `runVerifyJob` reporting that our own sandbox or runner never got to
  look — the artifact stays `UNOBSERVED`, which was always true. It became its own `JobState`
  because the UI had to separate "the backup is bad" from "the check could not run" on the jobs
  list, and while both were `FAILED` the only handle it had was grepping the reason string. Only
  VERIFY jobs use it; the smoke aborts on it by name, since a case block that only knew `FAILED`
  would let it wait out the clock.
  **That law covers CHECKSUM too, and it did not.** `checksumMatches` returned a boolean and
  streamed the object inside `runVerifyJob`'s `try`, so every failure of the DOWNLOAD — a 503 from
  the bucket, a reset socket, an expired credential — landed in the catch and marked the artifact
  `FAILED`: a good backup painted red because we could not look at it, with an `ARTIFACT_FAILED`
  notification and an invitation to delete it. It is now `compareChecksum`, three-way like
  `fullRestore`: `MATCHED`, `MISMATCHED` (the hash differs, or `isObjectMissing` — there are no
  bytes at that key, which IS a verdict), `INCONCLUSIVE` for everything else. The outer catch is
  `INCONCLUSIVE` as well, because every verdict path sets the artifact explicitly before it and a
  database blip in `setJobState` after a green verdict used to flip a verified backup to red. The
  outcome's `finalState` gained `UNCHANGED` for exactly this: an artifact a previous verify proved
  good is still `VERIFIED`, and calling it `UNOBSERVED` would report a downgrade nobody made.
- **A `FAILED` verify says what the restore said.** `fullRestore()` returns a `FullRestoreResult` —
  the proof plus a `cause` — because one FAILED proof covers two findings an operator acts on
  differently: a restore that completed and then counted nothing, and a restore that never
  completed (pg_restore refusing an extension the sandbox image lacks, a mysql client aborting on
  a DEFINER the sandbox has no user for). Both used to reach the job as the one sentence "the
  artifact restored but produced no usable schema", written also when nothing had restored, and
  `RESTORE_EXECUTOR_FAILED` carried the exit code alone while the runner had already captured and
  redacted the tool's stderr. `describeToolFailure` (restore-executor.ts) keeps the tail of that
  stderr in the typed message; the same rule that lets the INCONCLUSIVE log keep `detail` — a
  `SchrodumpError` message is built from redacted stderr, never driver prose — lets the verify
  persist it as the job reason.
- **A postgres backup by a non-superuser succeeds, and says its roles carry no passwords.** Every
  postgres backup writes `globals.bin` (`pg_dumpall --globals-only`) beside the database dump, and
  pg_dumpall reads password hashes from `pg_authid`, which only a superuser may. So the first backup
  of every managed postgres and of every least-privilege role used to FAIL at that step. The probe
  now answers `canReadRolePasswords` (see `packages/engines/CLAUDE.md`), the adapter adds
  `--no-role-passwords` when it is false, and `rolePasswordsCapturedFor` (worker-wiring) records the
  same fact on the manifest and the row as `rolePasswordsCaptured` — optional on the manifest and
  nullable on the row, like `sourceHasOplog`, because every artifact already written lacks it and a
  catalog rebuild must still parse them. A test pins the recorded fact against the flag the adapter
  actually emits, since the two are decided in different packages from one input.
- **A failed backup job carries the tool's words, and leaves nothing in the bucket.** Both dumps and
  the STAGED archive step throw `describeToolFailure` (restore-executor.ts) — the step, the exit
  code, the runner's redacted stderr — where they threw the exit code alone: a managed postgres
  refusing `pg_authid` read "dump execution failed (exit code 1)". And `runBackupJob` calls
  `discardObjects` on any failure before `persistArtifact` returns, deleting every key the ports
  started writing (artifact.bin, globals.bin, manifest.json). Before that the database dump
  uploaded first and a later refusal left it in the bucket with no manifest and no row — nothing,
  retention and the delete route included, starts from anything but the row. After the row exists
  nothing is discarded: the objects are the artifact then, and deleting them would leave a row
  pointing at nothing. A failed discard is appended to the reason rather than swallowed.
- **A postgres dump is never schema-scoped by discovery.** `dumpScopeFor` hands the postgres adapter
  the probe's databases but the TARGET's schemas (empty unless an operator set them through the
  API; the interface never does). The probe lists every non-system schema of the connected database
  and the adapter turns each entry of `scope.schemas` into `-n`, under which pg_dump dumps only
  objects in those schemas — extensions are database-level and are left out. Every postgres dump
  went out that way since the adapter existed; the first restore-verify of a database using
  `citext` FAILED with `type "public.citext" does not exist` under SUCCEEDED backups, once #138
  let the reason through. The smoke and `full-restore-verify.integration.test.ts` fixtures now
  carry a `citext` column so the gate sees an extension. Measured on postgres 18: a whole-database
  `-Fc` dump restores clean over an empty database and over a live one that already holds the
  extension (`--clean --if-exists` drops the dependent table before the extension).
- **A mysql/mariadb dump is STAGED only when its target names exactly one database.** `mydumper -B`
  copies one database by name, and the descriptor read `-B connection.database` — for an unscoped
  target, `mysql`, the system schema `probeDatabaseFor` connects through. `parallelism > 1` (or the
  size threshold) routed an unscoped target there: the job SUCCEEDED over no user data, and the
  unscoped verify, downgraded to CHECKSUM by `resolveVerifyPlan`, made it VERIFIED. A
  multi-database selection kept only its first. Two locks now. `resolveExecutionMode` takes
  `singleDatabaseStagingScope` as a **required** input — `backupContextFor` passes the target's
  selection for mysql/mariadb and null for the others — and streams, with a warning, any target that
  does not name exactly one. The adapter refuses a STAGED scope that is not exactly one database,
  and `dumpScopeFor` hands a STAGED mysql dump the target's selection rather than the probe's
  discovery, because a root credential discovers `mysql` and `sys` beside the database picked (the
  compose smoke's STAGED step is exactly that shape). The route still places no count on mysql
  scopes: unscoped legitimately means every database, and STREAM is what copies that.
- **An execution-mode degradation is written on the job.** `resolveExecutionMode`'s warnings
  (parallelism clamped, no scratch, staged unavailable) were returned in the outcome and read by
  nobody. `runBackupJob` now writes them as the SUCCEEDED job's `reason` — the ledger shows it as
  what the run reported — and `createJobExecutor` logs each with the job id.

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
- **`TestConnectionResult` carries `databases` (name + size) and `isReplicaSet`.** The probe always
  measured them and the worker always used them (STAGED routing, the scratch reservation); the
  operator never saw them. On a real deployment the 9.4 GB database an unscoped postgres target left
  behind was in that list, discarded on the way out. Names and sizes are not credentials, and the
  caller has already supplied the credentials that produced them — so they leave this module, and
  the driver's prose still does not.
- **`POST /targets/discover` (operator+, `routes/targets.ts`) probes a connection that has not been
  saved.** The password travels in the body, is used for that one connection and is discarded — the
  same posture as the password on create. It probes unscoped, through the engine's maintenance
  database, exactly as the backup's own probe will, so "discovery works" also means "the backup can
  probe". It exists so the form can offer the scope as a choice over what the server actually
  holds instead of a typed name.

## Egress: one guard for every address an operator types (`egress/guard.ts`)

- **Four fields name an address this process then dials** — a webhook channel's `url`, a
  destination's S3 `endpoint`, an SMTP channel's `smtpHost`, a target's `host` — and every one of
  them reports back whether something answered: the webhook's status through `lastFailure`, the
  canary's `failedOperation`, the probe's `ProbeFailureCode` + `driverCode`. That is a port scanner
  with a credential form in front of it, and the server sits on `internal` beside `db:5432` and
  `docker-proxy:2375`. An **operator** — a role deliberately denied the host and the metadata
  database — could point a channel at the proxy, press "send a test" and read the status; the
  webhook path is a POST and the proxy's CONTAINERS/IMAGES/NETWORKS + POST accepts Docker's
  body-less prune endpoints, so it is a DoS primitive too. (It cannot forge a container create: the
  body is the fixed notification JSON.)
- **The default is narrow on purpose, and the narrowness IS the decision.** Refused: loopback,
  link-local (`169.254.169.254`, the metadata service), the unspecified address, and this
  deployment's own services — the compose aliases plus whatever `DATABASE_URL`, `DOCKER_HOST` and
  `SCHRODUMP_URL` name, by name AND by the address they resolve to, plus every address this process
  is bound to (which is what makes "the API's own port" hold over the bridge, not only over
  loopback). **RFC-1918 and ULA are ALLOWED.** A database on `10.0.0.5` and a MinIO on
  `192.168.1.10` are the normal case for a self-hosted backup tool; a default that blocked them
  would break more deployments than it protected and be switched off by the first operator it
  inconvenienced. `SCHRODUMP_EGRESS_DENY` adds CIDRs; `SCHRODUMP_EGRESS_ALLOW` overrides every
  refusal including the built-ins, for the one case the self-service rule gets wrong on purpose (a
  metadata postgres that also holds a backed-up database). Both are validated in `env.ts`, so a
  typo is a boot failure naming the variable rather than a rule that silently does not apply.
- **It judges the RESOLVED address, not the name.** `internal.example.com` with an A record of
  `127.0.0.1` is the oldest way past a name-based block. Addresses are compared as BYTES, so
  `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same loopback as `127.0.0.1` — text matching
  catches one of the three. A name that does not resolve is **allowed**: there is no address to
  pivot to, and refusing would turn a typo into a policy complaint instead of `UNREACHABLE`.
- **Required, never optional, at every seam** — `WebhookDeps`, `SmtpDeps`, `testTargetConnection`'s
  second argument, `driverForDestination`'s `access`. Same shape as `readCredential`'s mandatory
  context: a call site that can be written without one is a call site the tenth author writes
  without one. `driverForDestination` is where the S3 endpoint is checked because every S3 use in
  the product — canary, backup upload, verify download, retention delete, catalog rebuild — goes
  through it, and it checks **before** `readCredential`, so an address we will not dial never
  unwraps a secret or writes an art. 37 access row.
- **The probe THROWS `EgressRefusedError`; it does not return a seventh `ProbeFailureCode`.** The
  six codes describe what a database said. "This server will not dial that address" is not one of
  them, and folding it into `UNREACHABLE` would tell the operator the host is down when it is the
  policy that declined. `/targets/discover` and `/targets/:id/test-connection` catch it and answer
  400 naming `host`; `test-connection` records **no** probe, on the same reasoning as INCONCLUSIVE
  — nothing looked, and overwriting `lastProbeFailure` would replace the last real answer about the
  database with one about our own configuration.
- **Webhook redirects are followed by hand and re-checked on every hop.** A stored URL on a host the
  operator owns, whose 302 points at `docker-proxy:2375`, walks straight past a check made before
  the request — and `redirect: "follow"` hands the whole chain to undici, where there is no seam to
  check anything. 301/302/303 become GET without a body, 307/308 keep the signed POST, and one
  15 s timeout covers the chain rather than one per hop.
- **`checkUrl` also refuses a non-http(s) scheme.** `z.url()` accepts anything `new URL()` does, so
  without it a channel could be stored as `file:///etc/passwd` and the refusal would arrive at
  delivery as a fetch error nobody can read.
- **What is NOT covered: DNS rebinding.** A name that resolves to an allowed address for the check
  and a refused one for the socket gets through. Pinning the connection to the checked address is
  not something the database drivers or the S3 SDK offer. Written down in `docs/security.md` rather
  than pretended away.
- **`egress/guard.fixture.ts` is test-only** (`allowAnyEgress`, `refuseAnyEgress`,
  `defaultPolicyGuard`) and nothing in the running server imports it. `defaultPolicyGuard` builds
  the REAL guard with the shipped defaults over a stub resolver — the "a private address still
  works" cases are asserted against it, because a permissive stub would prove nothing about the
  half of this feature most likely to break a deployment.

## Target TLS: three modes, one reading (`DatabaseTarget.tlsCaCert`)

- **`tls` was a boolean the probe and the tools read differently.** The probe verified strictly
  against Node's bundled CAs with no way to add one; `pg_dump` ran `sslmode=require` and the mysql
  clients `REQUIRED`, verifying nothing. So every managed database (RDS, Cloud SQL, Supabase, anything
  self-signed) failed test-connection — and every backup, which probes first — while a server that
  did connect was dumped over a channel open to anyone in the middle. The mongo tools were worse:
  the adapter emitted `--tls`, which mongodump/mongorestore 100.x reject as an unknown option, so no
  mongo target with TLS on (the default) could ever be dumped.
- **Now `tls` + `tlsCaCert` are read by ONE function, `targetTlsOf` (engines `descriptor.ts`),** for
  the probe and every descriptor alike: off / require (encrypted; unverified for postgres and
  mysql/mariadb, system trust store for mongo) / verify-full (the target's CA, host name checked).
  Every connection built from a row goes through `tlsOf` (`jobs/worker-wiring.ts`) — backup, restore,
  the restore's own probe, test-connection (`routes/wiring.ts`) and `/targets/discover` — so none of
  them can be the one that forgot the CA.
- **The CA is public and stored in clear** — a TEXT column, returned by GET. The API (`routes/
  targets.ts`, `parseTlsCaCert`) keeps only what node:crypto parses as certificates, refuses any
  other PEM block (a pasted private key is the likely mistake, and this column goes to every viewer),
  caps it at 256 KiB (the RDS global bundle is 165,408 bytes) and refuses a CA sent with `tls: false`
  — on PATCH judged against the row's own `tls` when the patch does not set it. PATCH: absent keeps,
  a PEM replaces, `null` clears. A CA kept on a row whose TLS was switched off is inert.
- **The tools read the CA from a file**, bind-mounted read-only at `TLS_CA_PATH`. For a restore it is
  materialized into the pipeline's own staging reservation beside mongo's `--config`
  (`withConnectionMounts`). For a backup it gets a directory of its own, `<scratch>/<jobId>.tls-ca`
  (`jobs/tls-ca-file.ts`), NOT a reservation: a STAGED dump takes the job's reservation itself,
  `pg_dump -Fd` refuses a non-empty staging directory, the archive step would tar the CA into the
  artifact, and a second reservation deadlocks the job against itself at
  `SCHRODUMP_MAX_CONCURRENT_STAGED=1`. It is mounted into every run that connects (the dump and the
  postgres globals dump), never the archive step. A CA with no scratch configured fails the backup
  first (`TLS_CA_SCRATCH_REQUIRED_REASON`), like mongo.
- **A mysql/mariadb TLS target without a CA is never staged.** mydumper/myloader fall back to
  plaintext under `--ssl-mode=REQUIRED` (measured). The adapter's `stagedTlsRefusal` is a required
  input of `resolveExecutionMode`, which streams such a target and writes why as the SUCCEEDED job's
  reason; the staged descriptors refuse on the same answer as the second lock.
- **Every certificate-verification code classifies as `TLS_FAILED`** (`probe/test-connection.ts`),
  by code — `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`,
  `ERR_TLS_CERT_ALTNAME_INVALID`, mysql2's `HANDSHAKE_SSL_ERROR`, `ERR_SSL_*`… — and the code is
  looked for down the `cause` chain, where the mongo driver keeps it two levels deep. They came back
  UNKNOWN (or TIMEOUT, for mongo), and the UI told the operator to check the TLS switch. The compose
  smoke's step 22 proves it end to end: a postgres that accepts only TLS, a throwaway CA, VERIFIED by
  restore, a wrong CA refused as `TLS_FAILED`, and a CA-less target still backing up.

## Env (what the server actually reads)

`env.ts` validates with Zod. Beyond `DATABASE_URL`, `PORT`, `SCHRODUMP_KEK`, `SCHRODUMP_URL`,
`SCHRODUMP_ADMIN_EMAIL`/`SCHRODUMP_ADMIN_PASSWORD` (and `BETTER_AUTH_SECRET`/`LOG_LEVEL`), it reads
the worker/executor configuration: `SCHRODUMP_SCRATCH_PATH`, `SCHRODUMP_SCRATCH_MAX_BYTES`,
`SCHRODUMP_MAX_CONCURRENT_STAGED`, `SCHRODUMP_EXECUTOR_NETWORK`, `WORKER_POLL_MS`,
`SCHRODUMP_SCHEDULER_TICK_MS`, `SCHRODUMP_SHUTDOWN_GRACE_MS`,
`SCHRODUMP_STAGED_THRESHOLD_BYTES`, `SCHRODUMP_NOTIFY_MIN_GAP_MS`, `SCHRODUMP_TRUSTED_PROXIES`,
`SCHRODUMP_TZ`, `SCHRODUMP_EGRESS_DENY`/`_ALLOW`, and the self-backup trio
(`SCHRODUMP_SELF_BACKUP_DESTINATION_ID`, `_INTERVAL_MS`, `_NETWORK`). An absent scratch path ⇒
STREAM-only (no staged/parallel).

> **`SCHRODUMP_TZ` is the one clock every cron is read on (default `UTC`), and it is per
> instance, not per policy or per viewer.** Validated with Intl — the zone database cron-parser
> reads through Luxon and the browser renders with — and stored in its canonical spelling; an
> unknown name, an empty value or a bare offset (`+03:00`: no DST rules, and older browsers cannot
> render it) stops the boot naming the variable, rather than reaching cron-parser and throwing on
> every tick. The process clock stays UTC; the zone is applied where a cron is read. `GET /me`
> carries it (`timeZone`), because every role needs it and the policy form needs it before any
> policy exists — `GET /instance` is admin-only, and turning `GET /policies`' bare array into an
> envelope would have broken every client.

> **`SCHRODUMP_ADMIN_EMAIL` is `z.email()` and `SCHRODUMP_ADMIN_PASSWORD` is `min(12)`,** the same
> floor as `minPasswordLength` in `auth.ts`. Validating it here means a too-short value is a legible
> boot failure that names the variable, instead of a Better-Auth error surfacing from wherever the
> bootstrap happened to be. Both are optional, but an empty string is an **invalid** value, not
> "unset", and it stops the boot — leave them absent to create the admin through the setup link.

> **`SCHRODUMP_STAGED_THRESHOLD_BYTES` has no default, and that is the decision.** STAGED is faster
> on a large database, but it writes the clear-text dump to disk before uploading and requires the
> scratch volume to be sized for it — so the mode is never chosen FOR the operator on the basis of
> size. `parallelism > 1` on the policy is the explicit, per-policy path (for mysql/mariadb, only on
> a target that names exactly one database — see the invariant). Before this was fixed the
> threshold defaulted to `SCHRODUMP_SCRATCH_MAX_BYTES`, which is the **volume ceiling**, not a
> routing threshold: the effect was to stage only dumps larger than the entire scratch budget.

> **`SCHRODUMP_TRUSTED_PROXIES` decides whether the login rate limit is real.** It is the
> comma-separated list of CIDRs for every hop in front of this server (the TLS-terminating reverse
> proxy, plus `127.0.0.1/32` for the shipped image's internal UI rewrite). Unset, nothing is
> trusted and the server warns at boot — because the alternative, trusting a forwarded header by
> default, buckets the limit on a value the attacker sets.

> **`SCHRODUMP_EGRESS_DENY` / `SCHRODUMP_EGRESS_ALLOW` are comma-separated CIDR lists, empty by
> default.** They move a line that is already drawn: see "Egress" above for what is refused without
> them and why RFC-1918 is not. Validated here — an entry that is not a CIDR (or a bare address)
> stops the boot naming the variable and quoting the entry, on the same reasoning as
> `SCHRODUMP_TZ`: a typo in a deny list is a rule that silently does not apply, and the moment
> anybody notices is the incident it was written for. Empty is absent, because compose passes them
> through as `""`.

> **Note:** `DOCKER_HOST` does not go through `env.ts` — the runner (dockerode) reads it straight
> from the environment. The egress guard does read it (`egress/wiring.ts`, passed in rather than
> reached for), because a `tcp://` value names the socket proxy and that is precisely the host this
> server must never be talked into dialling.

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
   backup, `Decrypter` on restore; keygen from the same library), 2 recipients (operational +
   escrow) — except on a **sealed** destination, which gets the escrow recipient alone
   (`recipientsForSealMode`, `crypto/artifact.ts`). The server never stores the escrow identity, so a
   sealed artifact is one this instance can write and never read: verify is checksum-only (the hash
   is over the stored bytes), restore is refused ("no server-held identity") and runs outside
   Schrodump, and `GET /artifacts` says so per artifact (`serverCanDecrypt`, from the manifest's
   `keyIds` against the keys this server holds an identity for). Sealed used to mean nothing but a
   verify downgrade: every artifact was sealed to the operational key too. There is **no `age` executor**: encrypting inside a container required stdin over a
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
- **`credential.read` is recorded too, by `crypto/credential-access.ts`.** It cannot ride this hook
  — decryption happens inside job execution, where there is no request and no user — so those rows
  carry a null `userId` and are attributed through `correlationId`. The context is a **required
  argument** of `readCredential`, and eslint refuses a direct import of `decryptCredential` outside
  `crypto/`: a new call site cannot decrypt without naming the organization, the resource and the
  purpose. That shape is the lesson of this file applied a second time — a call each site remembers
  to make is a call the tenth site forgets.

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
- **`deliver.ts` is the one path to the wire, and both callers take it.** The scheduled loop and
  the operator's "send a test" button call `deliverToChannel`. This is not tidiness: a test button
  with a dispatch of its own could report a healthy channel while every real notification failed,
  which is the exact shape of the bug in `secret-envelope.test.ts`. If you add a third caller, it
  goes through this function too.
- **A channel obeys the artifact's ternary.** `lastSuccessAt` next to `lastFailureAt`, both NULL is
  **UNOBSERVED**, and the later of the two decides VERIFIED or FAILED (a tie reads FAILED). A
  success does **not** clear the failure — a channel that recovered still carries the evidence that
  it broke, and the delete flow leans on that evidence. Derived in the UI (`channelState` in the
  web's `lib/domain.ts`) rather than stored, so no third column can drift out of agreement with the
  two timestamps.
- **`POST /notification-channels/:id/test` delivers for real, and reports failure with a 200.** The
  question "does this channel work?" is only answerable by answering it; a test that cannot fail
  proves nothing, so the body carries `ok` and the caller reads it rather than the status. The
  payload carries `trigger: "TEST"` and an SMTP subject that says Test, never Alert — proving the
  channel works must not page whoever is on call with something that never happened. `"TEST"`
  widens the *wire* vocabulary only; `evaluate.ts` keeps its exhaustive three, because nothing
  about a fleet produces it.
- **A real delivery records `lastSuccessAt` too, not only the test button.** The loop counted its
  successes and told the row nothing, so a channel quietly carrying every alert for a month still
  read UNOBSERVED — a lie in the opposite direction from the one this feature exists to prevent. A
  notification that arrived is stronger evidence than a rehearsal.
- **`notifications/wiring.test.ts` covers the seam, which had none.** `evaluate.ts` is pure and
  thoroughly tested, the delivery functions are tested, and the loop that joins them to the
  database was the one part with no test at all — which is exactly where the JSON.parse bug lived
  for the whole life of the feature. Keep it covered.
- **Email is always TLS with strict verification, and `SCHRODUMP_SMTP_CA_FILE` only ADDS trust.**
  A public relay needs nothing. An internal relay behind a private CA could not be used at all —
  the handshake failed and no configuration existed to fix it — which is an ordinary shape for a
  self-hosted deployment to have. The variable takes a PEM path read once at boot; there is
  deliberately no path to `rejectUnauthorized: false`, and `smtp.test.ts` asserts that. Empty
  counts as absent, because compose writes `""` for an unset variable and a literal `""` would
  fail the boot of every deployment that never asked for it.
- **The compose smoke delivers a real email (step 19).** It stands up an SMTP sink
  (`scripts/smoke-smtp-sink.mjs`) with a certificate signed by nothing the image trusts, so one
  step proves three things: the email arrives, the CA variable survives the compose plumbing, and
  the subject says Test rather than Alert. The smoke covered webhook delivery end to end and never
  once delivered an email, while the bug that motivated the coverage broke both kinds identically.
- **Job events are an opt-in firehose, and the fleet default is unchanged.** `evaluate.ts` still
  emits only the three fleet triggers and knows nothing about jobs — the unit of **alerting** is
  the fleet. `deliverJobEvents` on a channel adds one delivery per `BackupJob` state transition on
  top of that. The architecture decision keeps its meaning: this is an axis beside it, not a
  reversal, and the UI states the volume the moment the box is ticked rather than letting it be
  discovered from an inbox.
- **The outbox is written by a database TRIGGER, never by application code.** `claimNextJob` flips
  `PENDING → RUNNING` in raw SQL, because the claim has to be atomic against concurrent workers
  (`FOR UPDATE SKIP LOCKED`). A Prisma client extension — the mechanism `data/scope.ts` uses for
  `organizationId` — never sees that statement, so an application-side writer would miss the single
  most common transition in the system. The trigger also catches whatever write site is added next
  year by someone who never read this file, and it writes in the job's own transaction, so an event
  can neither be lost to a crash between the two writes nor outlive a rolled-back state change.
  This is the **only** trigger in the project; `job-event-trigger.integration.test.ts` is where it
  is proved, and removing the trigger turns all four of its cases red.
- **An event is marked delivered after the pass that ATTEMPTED it**, accepted or not — the same
  trade-off `notificationState` makes, so one dead channel cannot replay the backlog to the healthy
  ones forever; the failure lands on the channel row the interface already watches. Marked even
  when nothing subscribed, or the trigger would grow a table behind a feature nobody switched on.
  Drained 200 at a time, oldest first, and delivered rows are pruned after a day.
- **The job's state is part of the idempotency key.** Without it, `PENDING`, `RUNNING` and
  `SUCCEEDED` of one job all hash to the same key and a receiver that deduplicates — which is
  precisely what the header asks it to do — keeps one delivery out of three. The fleet triggers'
  keys are unchanged, and a test pins that.
- **Both delivery paths are bounded (15 s).** Node's `fetch` has no default timeout at all, and
  nodemailer's stages need `connectionTimeout`/`greetingTimeout`/`socketTimeout` separately. This
  was survivable while delivery only ran inside the scheduler tick; it now also runs inside an
  operator's HTTP request, where a black-holed host would hold that request open forever.
- **With no channel configured, nothing is evaluated at all** — no snapshot row, no state row, no
  work. Correct (there is nowhere to deliver), and worth knowing before debugging: an operator
  looking for evidence that notifications run will find an empty `NotificationSnapshot` table and
  reasonably conclude the loop is broken. It starts on the first channel.
- **State moves whether or not delivery succeeded**, and the trade-off is deliberate: otherwise an
  unreachable channel turns every tick into a fresh "opened" for the same condition. The cost is
  that a condition alerted while the channel was down is not re-alerted when it comes back — which
  is why `lastFailure` on the channel is the thing that must be watched, not the absence of alerts.
- Verified end to end on a deployment: `POLICY_QUIET` reached a real receiver as
  `{"trigger":"POLICY_QUIET","kind":"opened","summary":"policy \"q\" has never produced a
  successful backup"}` with an `X-Schrodump-Signature` header.

## Self-backup (`jobs/self-backup*.ts`)

- **A non-zero exit fails the self-backup.** The runner reports a tool's exit code by RESOLVING
  with it, and this path checked only whether the promise REJECTED — so a `pg_dump` that died
  partway and exited 1 having written some bytes was recorded `SUCCEEDED`, with a truncated dump.
  The artifact path has checked `exitCode !== 0` since the 9.4 GB dump that reached the bucket as
  877 bytes; this one had not. It is the FAST recovery path for a lost metadata database — the
  alternative is rebuilding the catalog from every manifest in the bucket — so a truncated one
  marked good is the copy an operator reaches for on the worst day. The failure carries the tool's
  own stderr through `describeToolFailure`, and the object is removed before the throw: an object
  with no row and no manifest is one nothing will ever reclaim.

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
a global 100 requests / 10s, and a `customRule` of 5 attempts per 300s on `/sign-in/email`.
Credential stuffing is a slow grind, so the window that matters is minutes, not seconds. The bucket
key depends on `advanced.ipAddress.trustedProxies` — see `SCHRODUMP_TRUSTED_PROXIES` above.
`/sign-up/email` carried the same rule and no longer does: the route is not rate-limited, it is
unreachable (next section). A rule for an endpoint that answers 404 documents a control that does
not exist.

## Sign-up is blocked at the route, not disabled in the library (`auth/auth.ts`)

`registerAuthHandler` answers **404** for `/api/auth/sign-up/email` before the request reaches
Better-Auth. Every account in this product is created by the bootstrap or by an admin through
`POST /members`; the public endpoint had no legitimate caller and two consequences. An address
registered by a stranger is taken forever, because `User.email` is globally unique — `POST /members`
then answers 409 and that colleague can never be invited. And a sign-up **before** the first admin
existed closed `/setup` permanently, on a deployment with no administrator and no way to make one
(hence `adminExists`, below).

Two details that are load-bearing:

- **Not `disableSignUp`.** Better-Auth's option refuses inside the handler itself
  (`api/routes/sign-up.mjs` checks it first), so it would equally refuse `auth.api.signUpEmail` —
  which is exactly how the bootstrap and `POST /members` create their accounts. The **route** must
  be unreachable, not the function.
- **404, not 403.** An endpoint that answers "forbidden" still tells a stranger it is there.

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
  separate operation, on its own route (below).

## Key rotation (`POST /encryption-keys/rotate`, `crypto/key-rotation.ts`)

- **Nothing is re-encrypted and nothing moves.** Every read path already queried
  `encryptionKey` *without* filtering on state — the comment "ALL keys (active + retired): an
  artifact may have been encrypted with a now-retired key" predates this route. Rotation changes
  which key the NEXT backup seals to; existing artifacts stay readable through the key they were
  written with, resolved from the **manifest** by `resolveDecryptionKeyId`.
- **The predecessor is retired, never deleted, and `encryptedIdentity` is left untouched.** Clearing
  it would make every artifact sealed to that key unopenable by the server — a routine rotation
  turned into silent, unrecoverable data loss that surfaces only at the next restore. The
  integration test seals a payload *before* rotating and opens it *after*, from the retired row;
  adding `encryptedIdentity: null` to the retire step reddens it.
- **One type at a time, and both halves in one `$transaction`.** Retiring and creating must not
  interleave: a window with zero active keys fails every backup, and a window with two makes
  `resolveRecipients`' `find` pick by row order.
- **409 for both blockers.** `not_provisioned` — rotation succeeds an existing key; an organization
  with none needs provisioning, and answering with a rotation would hide that it never had one.
  `ambiguous_active` — two active keys of a type means `find` has been choosing by row order, and
  picking one to retire would be guessing which one it had been choosing.
- **The response always carries `consequences`, success included, and says what rotation did NOT
  do.** Rotating an exposed key protects future backups only: every artifact already written stays
  sealed to the outgoing recipient, and whoever holds the leaked identity still opens all of them.
  A rotation that answered with an id alone would read as "exposure handled". It is not — the
  remedy for exposure is re-taking or deleting those artifacts, and the API says so.
- **Escrow rotation puts an obligation on the operator; operational rotation does not.** The server
  never held the outgoing escrow identity, so it is the only thing that can open self-backups and
  artifacts written before the rotation. `operatorMustRetain` carries that sentence; for operational
  it is null, because the outgoing identity stays in the row.
- **An operational key is always server-generated** — the server must hold the identity to verify
  and restore, so there is no operator-supplied variant. Escrow mirrors provisioning
  (`generate` | `recipient`), validated by age itself, bech32 checksum included.

## Bootstrap and the setup link (`bootstrap/`)

If `SCHRODUMP_ADMIN_EMAIL`/`_PASSWORD` are absent, the first boot mints a setup token: 32 random
bytes, **only the SHA-256 hash is persisted**, single-use, 60-minute TTL. The raw token exists in
the boot log line and in the operator's URL, nowhere else — so a leaked database does not hand over
an admin-creation link, and an old log line stops working after an hour.

**The question asked is `adminExists`, not "is there a user".** Both the boot gate and `/setup`
count administrators — a `Membership` with role `admin` — because a `User` row on its own proves
nothing about whether this deployment can be administered. Counting users let a single stray
account (a sign-up, or a creation that failed halfway) close the setup link forever.

**Creating the admin is idempotent, because its three writes cannot share a transaction** —
Better-Auth writes the `User` and `Account` through its own adapter. The organization is an
`upsert` on the slug, sign-up is skipped when the address already exists, and the membership is an
`upsert`. A failure between the writes used to leave the organization behind, and every retry then
died on the slug's unique constraint. **The setup token is spent last**, after the admin is real:
spending it first burned the one link the deployment had, and the next boot mints a token only when
there is no admin — which there still was not. Re-using a token that produced nothing is the lesser
risk; it is single-use, an hour old at most, and the window is one failed request wide.

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
  **mysql/mariadb**, which still restore the whole dump regardless of the requested scope. Mongo no
  longer is: `buildRestore` emits `--nsInclude`, which is what scopes `mongorestore`'s `--drop` to
  the requested namespace rather than the whole archive, and a request that names nothing to scope
  by is refused rather than widened. The proof is `mongodb-restore-scope.integration.test.ts`
  against a real mongod — it modifies a neighbour *after* the dump and asserts the modification
  survives, which is an assertion a descriptor test cannot make.

- **Mongo backup requires `SCHRODUMP_SCRATCH_PATH` to be configured** — the `mongodump`/
  `mongorestore` password travels only via a mounted `--config` file (never argv/env), and that file
  has to live at a path the Docker daemon can resolve (`RunMount.source`), i.e. the scratch volume.
  Without scratch configured, a mongo backup fails loudly and early
  (`MONGO_CONFIG_SCRATCH_REQUIRED_REASON` in `jobs/worker-wiring.ts`) instead of getting stuck deep
  inside the executor.

- **An unscoped postgres target is refused when the server holds more than the maintenance
  database** (`postgresUnscopedAlternatives`, applied in `buildDumpDescriptorFor`,
  `jobs/worker-wiring.ts`). `pg_dump` copies exactly one database — the one the connection is open
  to — and an unscoped target connects to `postgres`. On a real deployment that turned a 9.4 GB
  `acme_finance` into an 876-byte artifact under a `SUCCEEDED` job, and the row read "9.4 GB"
  because `sizeRawBytes` was the probe's server-wide estimate. Only a `FULL_RESTORE` verify caught
  it; the default `CHECKSUM` would have made it `VERIFIED`. The refusal is an `EngineDescriptorError`
  (the class `backup.ts` writes verbatim into `BackupJob.reason`) naming the databases left behind,
  and it fires before any container starts. When `postgres` is the only database it proceeds — that
  is where the data lives — and an explicit scope, including an explicit `postgres`, is never
  second-guessed. A mysql/mariadb STREAM dump is not affected: it receives every database the probe
  found (STAGED is — see the invariant above). `sizeRawBytes` is now the bytes the dump actually
  produced; the estimate keeps its two real jobs, STAGED routing and the scratch reservation, which
  are decisions taken *before* the dump.
  That guard is the **second** lock. The first is `scopeProblem` (`routes/targets.ts`), applied on
  create and on any PATCH that touches the scope (engine read off the row): postgres must name
  exactly one database, mongodb at most one, mysql/mariadb anything. And the form no longer has a
  free-text scope at all — its hint read "empty means all", which for postgres was the lie at the
  centre of the incident. `TargetForm` runs `/targets/discover` and offers the scope as a choice
  over what was found: one radio for postgres (the maintenance database is listed and marked, and
  is a legitimate explicit pick), checkboxes for mysql, and for mongodb a whole-instance lock when
  `isReplicaSet` comes back true. Nothing is pre-selected: even with a single non-maintenance
  database, the operator clicks. A default is what this replaces.

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
