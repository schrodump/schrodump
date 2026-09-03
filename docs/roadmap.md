# Scope of v1, and what is deliberately outside it

What follows is not a wishlist. It is the set of things that were considered, understood, and
left out — with the reason, so that the decision can be re-examined when the reason changes.

A backup tool that does one thing verifiably is worth more than one that does six things you
have to trust.

## Outside v1, on purpose

### Physical backups and point-in-time recovery

The single most requested capability, and the one with the clearest reason to be absent.

PITR means continuously archiving WAL (PostgreSQL) or binlogs (MySQL) and being able to replay to
an arbitrary moment. That requires a process **on the database host**: reading the data directory,
hooking `archive_command`, holding a backup label across a file-level copy. There is no way to do
it through the client protocol from a container somewhere else.

Schrodump's defining property is that it is agentless — nothing installed on your database
server, nothing to upgrade there, no new privileged process on the machine that holds your data.
PITR is incompatible with that property, not merely unimplemented. It waits for the agent.

Until then, be explicit with yourself: **your recovery point is the last dump, and your recovery
time is however long a restore takes.** Measure both. If either number is unacceptable, you need
physical backups, and Schrodump is not that tool yet.

### The agent, and why it would be written in Go

The agent is the prerequisite for physical backups, PITR and much faster large-database dumps.
It is not in v1 because it is a different product surface: an installed component, on a host
someone else owns, with its own upgrade path, its own privileges, and its own blast radius.

When it is written, it will not be written in Node. Not out of preference — because **Node is not
installable on a production database host** in the environments that matter. It is a runtime plus
a dependency tree plus a package manager on a machine whose owner has spent years keeping exactly
that off it. A Go binary is a single static file with no runtime, no dependency resolution at
install time, and a straightforward story for whoever has to approve putting it there. That
approval is the actual constraint, and it decides the language.

The server stays in Node. The agent is where the constraint is different, so the answer is
different.

### Local filesystem destinations

Storing backups on the same machine that runs Schrodump, or on a mounted NFS share, is not
supported.

The omission is a position, not an oversight. A backup on the host that holds the database
protects you from `DROP TABLE` and from nothing else — not disk failure, not ransomware, not the
fire. Offering it as a first-class destination makes the least useful configuration the easiest
one to choose, and it would be chosen, because it is the one that requires no credentials and no
bucket.

S3-compatible means MinIO too. A MinIO instance on another machine is a supported destination,
takes minutes to run, and is a genuinely different failure domain. That is the path.

### S3 Object Lock

Object Lock (WORM) makes artefacts undeletable for a fixed window — the standard defence against
an attacker who takes your infrastructure and deletes the backups before encrypting the primary.

It is out of v1 because it is not a checkbox. Object Lock changes retention from something
Schrodump decides into something the storage enforces, and the two must agree or the catalogue
starts describing artefacts it cannot delete. It also collides directly with the right to
elimination — see [lgpd.md](lgpd.md#the-hard-part-object-lock-versus-the-right-to-elimination),
which sets out the position to design against.

Shipping it half-right would be worse than not shipping it: a retention policy the operator
believes is running, silently failing against a lock they configured elsewhere.

### Self-backup: the catalog now backs itself up

Schrodump dumps its own metadata database on a cadence, to a destination an operator names, and
records every run so a misconfiguration is a visible row instead of a log line. See
[install.md](install.md#backing-up-schrodump-itself).

Two things about it are load-bearing and were nearly got wrong:

- **It seals to the ESCROW key and refuses to run without one.** The operational key's identity is
  stored inside the very database being dumped, so an artifact sealed only to it is unopenable in
  the exact disaster it exists for. Refusing beats writing a decoy.
- **A written self-backup is UNOBSERVED, not verified.** It is amber in the UI. A `pg_dump` that
  exited 0 is a process that did not complain — the same claim this product refuses to accept
  anywhere else, and it does not get an exception for its own data.

The catalog rebuild from bucket manifests remains the floor, and it is what makes a deployment
without a self-backup recoverable at all. The self-backup only makes it fast.

### Notifications: webhooks and SMTP both ship

Webhook notifications ship. The trigger is what the position below always said it had to be — a
change in what the fleet has and has not proven, never a job result:

- an artifact a verify proved bad (immediate, no hysteresis: it is a claim about data, not a
  process complaining);
- verification falling behind, which needs the unobserved count to fail to come down between two
  evaluations at least `SCHRODUMP_NOTIFY_MIN_GAP_MS` apart — without that gap the trigger fires on
  every healthy backup, since each is briefly unobserved between finishing and its chained verify;
- a policy that has gone quiet for more than twice its cron interval, which no failure-based alert
  can see, because a job that never runs never fails.

Notifications fire on TRANSITION and resolve with a closing message, so a condition that stays true
is not re-sent every tick. A channel that cannot be reached records the failure on itself rather
than failing silently — a notifier nobody can tell is broken is worse than none.

**SMTP ships too**, over an explicitly TLS-required transport — a notification carries the fleet's
state across someone else's network, which is not a tradeoff worth a config flag. A channel is one
kind or the other, discriminated, so the code cannot read the half that does not belong to it.

Routing rules and per-user preferences remain deliberately out: one channel set per organization.
Channels are configured through `/notifications` in the interface and a REST API behind it. Secrets
stay write-only there like everywhere else: a signing secret or SMTP password goes in and is never
read back. A channel's last delivery failure IS shown, because a notifier nobody can tell is broken
is worse than having none.

## Known limitations shipping in v1

Not scope decisions — things that are incomplete or sharp, verified, and written down so nobody
discovers them during an incident.

| Limitation                                                                                         | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A STAGED artifact is only as verifiable as its archive step                                        | STAGED now works end to end: the dump fills a mounted staging directory, a second run tars it to stdout, and the unchanged gzip -> age -> S3 chain uploads that; restore unpacks it and hands the directory to `pg_restore` / `myloader`. Three things had to land together, because each alone was a different way to lose data: the staging directory was never MOUNTED into the dump container (the dump landed in the container's own filesystem and died with it), nothing turned the directory back into a stream, and the upload read a stdout a directory dump never writes. What remains: `tar` comes from the engine's own image rather than a pinned executor, so an upstream image dropping busybox tar would break the archive step — caught by the integration suite, not by a digest.                                                                                                                                                                                                                                         |
| Unscoped MongoDB artifacts cannot be `FULL_RESTORE`-verified                                       | `mongodump --archive` on a replica set is always full-instance (a scoped dump is refused there — oplog consistency requires the whole instance), and the resulting archive restores each database under its own embedded name, with no single origin db to assert against. `resolveVerifyPlan` downgrades this case to `CHECKSUM` — never blocked, never a wrong verdict. A SCOPED mongo target (a single named database, which is never possible on a replica set) keeps `FULL_RESTORE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Mongo artifacts written before oplog provenance was tracked restore without replay                 | `buildDump` emits `--oplog` exactly when it dumps a replica set, and that fact is now recorded at dump time — on the manifest (`sourceHasOplog`, optional so every artifact already in a bucket still parses during a catalog rebuild) and on the `Artifact` row. `buildRestore` emits `--oplogReplay` when the fact is `true` AND the target is `FULL_CLUSTER`, so a replica-set-sourced restore now lands every collection on one instant. What remains: an artifact written before this shipped has NULL provenance, which is a weaker claim than `false` — it restores without replay, and the job records "restored without oplog replay: this artifact predates oplog tracking" rather than degrading in silence. The fact is deliberately not back-filled: re-deriving it would mean re-probing an origin that may have changed topology or ceased to exist. The replay path is now exercised end to end by the smoke's eighteenth step: a real replica set, an unscoped target, an artifact recording `sourceHasOplog`, and a `FULL_CLUSTER` restore over live data putting the pre-backup value back. |
| Mongo sub-scope restore is scoped by `--nsInclude`; MySQL/MariaDB sub-scope is still unimplemented | `buildRestore` reads `input.scope` and emits `--nsInclude=<db>.*` for a DATABASE target and `--nsInclude=<db>.<coll>` for a COLLECTION one, which is what scopes `mongorestore`'s `--drop` to the requested namespace instead of the whole archive — the two are one decision, not two flags. A request with nothing to scope by is refused rather than widened. Proven by `mongodb-restore-scope.integration.test.ts` against a real mongod: a neighbour is modified AFTER the dump and asserted to survive, and removing `--nsInclude` turns that red with a document count of 1 where 2 was expected, which is the data loss the withdrawal existed to prevent. What remains: **mysql/mariadb** still restore the whole dump regardless of the requested scope. |
| TABLE-scoped restore exists for postgres only; a multi-database MySQL artifact restores whole | No adapter emitted a table-scoping flag while the capability matrix advertised `TABLE` for postgres, mysql and mariadb — so a TABLE request ran `pg_restore --clean` (or the mysql client) over the WHOLE dump, dropping every table in the database to write one. **Postgres now emits `-t`**, which confines `--clean` to the requested tables, and refuses a TABLE request naming none; proven by `postgres-restore-scope.integration.test.ts`, where a neighbouring table is modified after the dump and asserted to survive, and dropping `-t` turns it red at 1 row where 2 was expected. **mysql/mariadb keep no TABLE**, and that is a limit rather than a deferral: MySQL provides nothing equivalent for replaying a dump script, and its own documentation calls `--one-database` rudimentary. Still live: mysql `DATABASE` restore is correct for a single-database artifact but NOT for one dumped with `--databases`, whose script carries `CREATE DATABASE`/`USE`/`DROP TABLE` for every database in it. Measured on mysql 8.4.10 — two databases dumped together, a row added to the second after the dump, the script restored "into" the first: the second went from two rows to one, the new row gone, client exit 0. That hazard is a property of the artifact rather than the engine, so it is written here instead of being encoded in a per-engine table. |
| `FULL_RESTORE` verify asserts the restored schema has at least one table                           | A legitimately empty database (zero user tables) verifies as `FAILED`. This is the deliberate "restore succeeds AND the schema is non-empty" semantics chosen for v1; backing up an empty database is not a supported case worth a weaker assertion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A `SIGKILL` delivered before `SCHRODUMP_SHUTDOWN_GRACE_MS` elapses skips the shutdown handler      | The server now installs a `SIGTERM` handler that stops claiming, aborts the in-flight run (the runner force-kills its container) and awaits the drain before exiting, releasing the in-flight job's scratch directory in the normal case. A `SIGKILL` — or a drain that outlasts the grace — still leaves that directory, holding a dump in clear, until the next boot sweep The abort-and-clean path itself was exercised against real Docker on 2026-08-30 — container gone, scratch directory gone, job `FAILED` — with the scope and the two gaps of that check written down in [security.md](security.md#scratch-holds-your-data-in-clear).                                                                                                                                                                                                                                                                                                                                                                                             |
| Retention only runs chained to a **successful** backup of the same policy                          | This is the safety property, not an oversight: pruning old copies is only ever safe at the moment a new one landed, so a FAILED backup never costs you an older artifact and a disabled policy stops deleting entirely. The consequence to know: a policy that stops backing up also stops enforcing its retention window, so artefacts outlive it until backups resume. A policy whose keep counters are all zero is treated as **unconfigured** — it prunes nothing and enqueues no job — because "keep nothing" and "never said" arrive at the resolver identically, and the second must never mean delete.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CI exercises one PostgreSQL, one MySQL/MariaDB and one MongoDB build per run, not the whole matrix | A MongoDB **replica set** is now stood up and probed by default, which closes the gap that mattered most: `isReplicaSet` is the single fact the entire oplog chain hangs from — it decides whether `buildDump` emits `--oplog`, whether that is recorded on the artifact, and whether a `FULL_CLUSTER` restore replays it — and until this it was unit-tested only. The engine images are overridable (`SCHRODUMP_TEST_POSTGRES_IMAGE`, `_MYSQL_IMAGE`, `_MONGO_IMAGE`), and CI runs a probe-only pass against MariaDB and the PostgreSQL range edges. A full round trip through the **composed deployment** now runs on every pull request (`scripts/smoke-compose.sh`), eighteen steps: compose up, the setup link, keys, a live destination canary, a real connection test, backups of PostgreSQL, MySQL, MariaDB and MongoDB in **both execution modes**, a `FULL_RESTORE` verify of each, a restore over live data for three of them, a catalog rebuild from the bucket alone, a key rotation with the pre-rotation artifact still readable, a self-backup sealed to escrow over the internal network, retention observed actually deleting without leaving part of a backup behind, a signed notification arriving at a real listener, and a replica-set round trip proving `--oplogReplay` end to end. It exists because three defects shipped in the seam between the code and `compose.yaml` that no other test could see. Trying to add that last step is what surfaced the defect in the row below: it was not a coverage gap but an unreachable path, and covering it is what forced the fix. |
| An unscoped MongoDB target now dumps the **full instance**, on a standalone as well as a replica set | A replica set could not be backed up at all until `dumpScopeFor` (`jobs/worker-wiring.ts`) landed: `probeMongodb` reports `scope.databases` as *every* database the credential can list, `worker-wiring` fed that straight into `buildDump`, and `buildDump` refuses `isReplicaSet && scoped` — so `scoped` was true for **every** credential (a broad one lists several databases, a narrow one lists its own) and no configuration reached the `--oplog` branch. Two deliberate rules had cancelled each other: `MONGODB_SCOPE_TOO_BROAD` tells the operator to scope the credential to one database, and `MONGODB_OPLOG_REQUIRES_FULL_DUMP` requires no scope at all. For MongoDB the dump scope now comes from the **target row** rather than from probe discovery — empty meaning the full instance, which is what a replica set requires and what "I did not scope this target" plainly means. A scoped target still narrows the dump and is still refused on a replica set, correctly. The consequence to know: this also changed the standalone case. An unscoped target that used to be refused with `MONGODB_SCOPE_TOO_BROAD` because its credential could list `admin`/`config`/`local` now dumps the whole instance instead. The SQL engines keep reading the probe — their scope is discovery, not intent, and narrowing them from the target row is a separate decision with its own consequences. |
| CI builds the image for the runner's architecture only; `linux/arm64` is built at release time  | `ci.yml` runs on amd64 runners, so the `image` job proves the Dockerfile on one architecture. `release.yml` builds `linux/amd64,linux/arm64`, and `docker/build-push-action` builds before it pushes, so an arm64 break fails the release rather than publishing half a manifest list — but it is found at the tag, not on the pull request that caused it. Both architectures were built and the arm64 image run end to end by hand on 2026-09-01: migrations applied, the API and UI came up, `/health` answered 200, and stopping PostgreSQL turned it 503 and the container `unhealthy` without killing it. The executor's per-architecture `.deb` checksums were verified by the same build. |
| Dangling `sharp`/`@img` symlinks remain in both dependency trees                                  | The libvips binary no longer ships: Next traces sharp into the standalone output for image optimisation this UI never uses, and the build now deletes it (35 MB of web runtime down to 17.5 MB). `outputFileTracingExcludes` does not cover it — Next special-cases sharp for the standalone server — so the cut is in the Dockerfile, next to the Prisma engine cuts, and the container smoke test is what proves it safe. What is left is ~12 KB of symlinks whose targets are gone, in `.pnpm/node_modules`, which `prune-store.mjs` preserves wholesale because removing that directory breaks every require. They contain no code. |
| The production image is ~612 MB against a 400 MB target                                            | Prisma's client and CLI account for roughly 275 MB of it; see the note below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

> **On that CI row.** An earlier version of it said the uncovered engines were "verified by
> hand, no defect of their own". That was wrong, and it is worth recording *how* wrong, because
> the sentence is the reasoning that let them survive. Covering them found: `schrodump/mydumper`
> could not authenticate to any MySQL 8.x (the image ships no `caching_sha2_password` plugin);
> `myloader` ran without a drop mode, so a STAGED artifact verified against an empty sandbox and
> failed the restore over live data that an operator actually needs; no mariadb 11 artifact could
> **ever** be verified, because the verify sandbox's readiness probe named `mysqladmin`, which
> that image does not ship; a STAGED postgres backup could never be verified or restored, because
> the tar-extract step was decided per pipeline and applied to the `globals.bin` SQL as well; and
> retention deleted two thirds of every backup, orphaning `globals.bin` — role password hashes —
> permanently outside the configured window. Every one of them is invisible to a descriptor test,
> which can confirm which string was chosen but not that the string names a binary the image
> contains.


### On image size

The target was under 400 MB and it is not met. These are measured, not estimated — `docker history`
and `du` inside the built `linux/arm64` image on 2026-09-01:

| Layer / tree                                    | Size    |
| ----------------------------------------------- | ------- |
| Node runtime layer + Alpine rootfs               | ~165 MB |
| `/app/server` (runtime dependency closure)       | 168 MB  |
| `/app/prisma-cli` (for `migrate deploy`)         | 120 MB  |
| `/app/web` (Next standalone + static)            | ~23 MB  |
| Application code (`dist` of every package)       | ~3 MB   |

So the two levers are Prisma's: the client inside `/app/server` is 50 MB on its own, and the CLI is
another 120 MB — 170 MB, 28% of the image, to apply migrations at boot and talk to PostgreSQL.

Also measured, and deliberately left alone: roughly 20 MB of transitive weight this process never
loads. `@opentelemetry/semantic-conventions` (12 MB) arrives through better-auth's telemetry,
`@grpc/grpc-js` and `protobufjs` (8 MB) through dockerode, which reaches the Docker daemon over
HTTP on the socket and not over gRPC. Both are declared runtime dependencies of packages that are
themselves loaded, so `prune-store.mjs` keeps them, correctly — deleting them is a bet against two
libraries' internals, and the subsystems it would break on a wrong guess are authentication and the
container runner. 3% of the image is not worth that; the note is here so nobody re-measures it.

The build already prunes what it can — the dependency tree is reduced to the runtime closure
(~600 MB removed), Prisma's WASM engines for database vendors Schrodump does not use are deleted,
and sharp with its bundled libvips is dropped from the Next standalone output (17.5 MB, and the
image scanner's standing complaint about this build). Getting materially below 450 MB means changing how migrations are applied, or how the
metadata layer reaches PostgreSQL. Both are real options; neither is a Dockerfile change.
