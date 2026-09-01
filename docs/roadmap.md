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
| Mongo artifacts written before oplog provenance was tracked restore without replay                 | `buildDump` emits `--oplog` exactly when it dumps a replica set, and that fact is now recorded at dump time — on the manifest (`sourceHasOplog`, optional so every artifact already in a bucket still parses during a catalog rebuild) and on the `Artifact` row. `buildRestore` emits `--oplogReplay` when the fact is `true` AND the target is `FULL_CLUSTER`, so a replica-set-sourced restore now lands every collection on one instant. What remains: an artifact written before this shipped has NULL provenance, which is a weaker claim than `false` — it restores without replay, and the job records "restored without oplog replay: this artifact predates oplog tracking" rather than degrading in silence. The fact is deliberately not back-filled: re-deriving it would mean re-probing an origin that may have changed topology or ceased to exist. Note also that the replay path itself is unit-tested only — CI runs no replica set (see the row below), so a real `mongorestore --oplogReplay` remains verified by hand. |
| Mongo sub-scope restore (DATABASE/COLLECTION) is withdrawn until `--nsInclude` scoping exists      | `buildRestore` never reads `input.scope` and drives `mongorestore` with `--drop` and no `--nsInclude`, so a scoped request would drop and overwrite EVERY namespace in the archive rather than the one asked for — and the capability matrix advertised those targets, which `runRestoreJob` validates against, making it reachable rather than hypothetical. Both the server matrix and the UI's copy now advertise `FULL_CLUSTER` only. They return together with `--nsInclude` scoping and an integration test that proves a scoped restore leaves neighbouring namespaces untouched — refusing meanwhile is the same call already made for STAGED restore.                                                                                                                                                                                                                                                                                                                                                                               |
| `FULL_RESTORE` verify asserts the restored schema has at least one table                           | A legitimately empty database (zero user tables) verifies as `FAILED`. This is the deliberate "restore succeeds AND the schema is non-empty" semantics chosen for v1; backing up an empty database is not a supported case worth a weaker assertion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A `SIGKILL` delivered before `SCHRODUMP_SHUTDOWN_GRACE_MS` elapses skips the shutdown handler      | The server now installs a `SIGTERM` handler that stops claiming, aborts the in-flight run (the runner force-kills its container) and awaits the drain before exiting, releasing the in-flight job's scratch directory in the normal case. A `SIGKILL` — or a drain that outlasts the grace — still leaves that directory, holding a dump in clear, until the next boot sweep The abort-and-clean path itself was exercised against real Docker on 2026-08-30 — container gone, scratch directory gone, job `FAILED` — with the scope and the two gaps of that check written down in [security.md](security.md#scratch-holds-your-data-in-clear).                                                                                                                                                                                                                                                                                                                                                                                             |
| Retention only runs chained to a **successful** backup of the same policy                          | This is the safety property, not an oversight: pruning old copies is only ever safe at the moment a new one landed, so a FAILED backup never costs you an older artifact and a disabled policy stops deleting entirely. The consequence to know: a policy that stops backing up also stops enforcing its retention window, so artefacts outlive it until backups resume. A policy whose keep counters are all zero is treated as **unconfigured** — it prunes nothing and enqueues no job — because "keep nothing" and "never said" arrive at the resolver identically, and the second must never mean delete.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CI exercises one PostgreSQL, one MySQL/MariaDB and one MongoDB build per run, not the whole matrix | A MongoDB **replica set** is now stood up and probed by default, which closes the gap that mattered most: `isReplicaSet` is the single fact the entire oplog chain hangs from — it decides whether `buildDump` emits `--oplog`, whether that is recorded on the artifact, and whether a `FULL_CLUSTER` restore replays it — and until this it was unit-tested only. The engine images are overridable (`SCHRODUMP_TEST_POSTGRES_IMAGE`, `_MYSQL_IMAGE`, `_MONGO_IMAGE`), and CI runs a probe-only pass against MariaDB and the PostgreSQL range edges. What is still NOT covered: a full backup-and-restore round trip on anything but the default images, and a replica-set round trip proving `--oplogReplay` end to end rather than the fact that feeds it.                                                                                                                                                                                                                                                                               |
| CI builds the image for the runner's architecture only; `linux/arm64` is built at release time  | `ci.yml` runs on amd64 runners, so the `image` job proves the Dockerfile on one architecture. `release.yml` builds `linux/amd64,linux/arm64`, and `docker/build-push-action` builds before it pushes, so an arm64 break fails the release rather than publishing half a manifest list — but it is found at the tag, not on the pull request that caused it. Both architectures were built and the arm64 image run end to end by hand on 2026-09-01: migrations applied, the API and UI came up, `/health` answered 200, and stopping PostgreSQL turned it 503 and the container `unhealthy` without killing it. The executor's per-architecture `.deb` checksums were verified by the same build. |
| Dangling `sharp`/`@img` symlinks remain in both dependency trees                                  | The libvips binary no longer ships: Next traces sharp into the standalone output for image optimisation this UI never uses, and the build now deletes it (35 MB of web runtime down to 17.5 MB). `outputFileTracingExcludes` does not cover it — Next special-cases sharp for the standalone server — so the cut is in the Dockerfile, next to the Prisma engine cuts, and the container smoke test is what proves it safe. What is left is ~12 KB of symlinks whose targets are gone, in `.pnpm/node_modules`, which `prune-store.mjs` preserves wholesale because removing that directory breaks every require. They contain no code. |
| The production image is ~612 MB against a 400 MB target                                            | Prisma's client and CLI account for roughly 275 MB of it; see the note below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### On image size

The target was under 400 MB and it is not met. The floor for this stack is roughly 450 MB before
any application code: Node on Alpine is ~170 MB, the Prisma client with its native query engine
is ~90 MB, the Prisma CLI needed for `migrate deploy` is ~115 MB, and the Next standalone output
is ~40 MB.

The build already prunes what it can — the dependency tree is reduced to the runtime closure
(~600 MB removed), Prisma's WASM engines for database vendors Schrodump does not use are deleted,
and sharp with its bundled libvips is dropped from the Next standalone output (17.5 MB, and the
image scanner's standing complaint about this build). Getting materially below 450 MB means changing how migrations are applied, or how the
metadata layer reaches PostgreSQL. Both are real options; neither is a Dockerfile change.
