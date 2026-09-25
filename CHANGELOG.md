# Changelog

Every notable change to Schrodump, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions are
[semantic](https://semver.org/spec/v2.0.0.html) with one caveat worth stating plainly: **nothing has
been tagged stable yet.** Every version below is a release candidate of `0.1.0`, so no compatibility
is promised between them, and the Docker tag `latest` has never moved — `release.yml` applies it
only to a tag that parses as exactly `X.Y.Z`.

Candidates publish to `:next`, and an exact version is what production should pin. See
[CONTRIBUTING.md](CONTRIBUTING.md#cutting-a-release).

## [Unreleased]

### Fixed

- **Retention deletes the artifact, not just its manifest and its row.** Every object a backup
  writes now goes through one key builder. It used to be two: the write path interpolated
  `${prefix}/${org}/${job}/${name}` while the manifest and every delete used
  `@schrodump/storage`'s builder, which strips surrounding slashes. They agree for every prefix
  except the one the destination form supplies by default — `""` — where one writes
  `/<org>/<job>/artifact.bin` and the other computes `<org>/<job>/artifact.bin`. Those are
  different S3 keys, so retention removed the sidecar and the catalog row, reported
  `retention kept 7, deleted 1`, and left `artifact.bin` and `globals.bin` in the bucket for good:
  storage outside the configured window, holding the role password hashes
  `pg_dumpall --globals-only` writes. **This was live.** It was found on a running instance whose
  `Artifact` rows carried `bucketKey = "/cmtq…"` next to `manifestKey = "cmtq…"` — the two paths,
  side by side, in one row. Retention now also deletes the key the row records, so artifacts
  written by an earlier version are reclaimed as they age out rather than left behind. Objects
  already orphaned by a past prune have no row left to name them and are not reclaimed by this
  change (#172).

## [0.1.0-rc.20] — 2026-09-25

The second pass of the pre-launch audit, and the last one before a stable tag: eleven pull requests
(#160–#170) closing the two remaining steps of the launch gate. One of them fixes a defect that was
live in every deployment — **nothing on screen refreshed itself**, so the jobs ledger ticked a
one-second clock over a list fetched once and the catalog stayed amber after the verify that had
already turned it green. Another is not in this codebase at all: MinIO withdrew its community images
from every anonymous registry, which had turned every branch of this repository red.

### Breaking changes

- **Public sign-up is gone.** `POST /api/auth/sign-up/email` answers **404**. Nothing in the product
  called it — accounts come from the bootstrap or from an administrator through `POST /members` —
  but an external script that used it stops working (#160).
- **The egress guard can refuse an address an existing row already holds.** A webhook URL, an S3
  endpoint, an SMTP host or a database target's host that resolves to loopback, to a link-local
  address, or to one of this deployment's own services (`db`, `docker-proxy`, `schrodump`, and
  whatever `DATABASE_URL`, `DOCKER_HOST` and `SCHRODUMP_URL` name) is now refused — at the route
  when it is saved, and at the moment of connecting for a row saved earlier. **RFC-1918 and ULA are
  deliberately not refused**, so an ordinary self-hosted install is unaffected. The one real case is
  a deployment whose metadata PostgreSQL also holds a database it backs up: name that address in
  `SCHRODUMP_EGRESS_ALLOW`, which wins over every rule including the built-in ones (#166).
- **A notification channel URL whose scheme is not `http(s)` is refused on create** — `201` became
  `400`. `z.url()` accepted anything `new URL()` does, so a channel could be stored as
  `file:///etc/passwd` and only fail, unreadably, at delivery (#166).
- **The UI sends `Content-Security-Policy: … frame-ancestors 'none'` and `X-Frame-Options: DENY`.**
  A deployment that embedded Schrodump in an iframe no longer can. Neither side sends HSTS: this
  container listens on plain HTTP and the operator terminates TLS in front of it — the `max-age`
  belongs in the proxy, and `docs/install.md` now carries it in the Caddy and nginx snippets (#167).

### Security

- **One egress guard for every address an operator types.** Four fields name a host this process
  then dials, and each of them reports back whether something answered — the webhook's status
  through `lastFailure`, the canary's `failedOperation`, the probe's `ProbeFailureCode`. That is a
  port scanner with a credential form in front of it, and the server sits on the `internal` network
  beside the metadata database and the Docker socket proxy: an **operator**, a role deliberately
  denied both, could point a channel at `docker-proxy:2375`, press "send a test" and read the
  reflected status. The guard judges the **resolved** address, not the name, comparing bytes so
  `::ffff:127.0.0.1` is the same loopback as `127.0.0.1`, and webhook redirects are followed by hand
  and re-checked on every hop. DNS rebinding is not covered and `docs/security.md` says so (#166).
- **Nobody can give themselves an account.** Better-Auth's sign-up endpoint was never a way *in* —
  the account it created carried no membership, so every guarded route answered 401 — but it was a
  way to take something: `User.email` is globally unique, so a stranger who registered a colleague's
  address held it permanently, and a sign-up **before the first administrator existed** closed
  `/setup` for good on a deployment that then had no administrator and no way to create one. It is
  blocked at the route rather than with Better-Auth's `disableSignUp`, which would equally refuse
  the call the bootstrap itself makes (#160).
- **The UI and the API both send security headers.** `@fastify/helmet` had been a declared
  dependency for months and was never registered, and `next.config.ts` had no `headers()`: no CSP,
  no `frame-ancestors`, no `nosniff`, no `Referrer-Policy`. The session cookie makes the browser the
  operator, and the two most destructive controls in the product are one click each — the restore
  dialog writes over a live database, the delete dialog destroys a VERIFIED artifact (#167).
- **Every direct dependency is at a version with no open advisory.** `pnpm audit` reported 31, and
  CI was green because the gate is set at critical on purpose. Almost every fix was already inside
  the range the manifests declared — a stale lockfile, not a missing patch. `fastify` and
  `nodemailer` needed their floors raised; the rest was a refresh. **31 → 4**, and the four that
  remain are listed in `docs/security.md` with what each reaches and why it stays (#162).

### Added

- **A demo stack that reaches a first VERIFIED backup in one command.** `compose.demo.yaml`
  `include:`s the shipped `compose.yaml` rather than copying it, and adds a sample database, a MinIO
  and a one-shot initialiser. Measured on a clean host: **5 min 43 s** from `up -d` to a green
  artifact, clicking through the UI as documented (#164).
- **A CHANGELOG**, reconstructed from the tags and the commit range between each, so nineteen
  release candidates read as a history rather than as churn. `CONTRIBUTING.md` carries the template
  for the next one, and `release.yml` links this file pinned at the tag (#161).
- **Screenshots, one capture per language.** Each README shows the artifact catalog as it renders,
  from a real stack: nine artifacts over ten days, three never opened, and one FAILED that was
  earned — its object in the bucket was overwritten and re-verified. Both themes ship, selected by
  `prefers-color-scheme`. `docs/backup-restore.md` gains the restore dialog beside the paragraph
  that describes it (#170).
- **A comparison with the tools a reader is already holding this against** — pgBackRest, Barman,
  WAL-G, restic, postgresus, `pg_dump` + cron, managed snapshots — and where Schrodump loses: no
  PITR, no physical backup, a recovery point no better than the last dump. That is structural, not
  unfinished (#161).
- **`SCHRODUMP_EGRESS_DENY` and `SCHRODUMP_EGRESS_ALLOW`**, both validated at boot, so a typo stops
  the start naming the variable rather than leaving a rule that silently does not apply (#166).

### Changed

- **The READMEs lead with what this is and is not.** A beta callout sits directly under the tagline
  in all three — one maintainer, twenty candidates, no stable release — saying what the
  twenty-two-step compose gate proves and what it does not, and pointing at the known limitations
  before anyone depends on this. It used to be the eighth section down (#161).
- **`COPYRIGHT` says contributions are certified by the DCO**, not by a Contributor License
  Agreement that never existed. No copyright is assigned; the contributor keeps theirs (#161).
- **Three claims were withdrawn because the code does not support them**: retention is not aware of
  full/incremental chains (there are no incremental backups — `dependsOn` is written `[]` on every
  artifact), the KEK does not live outside the host if you follow the quick start (it writes it to
  `.env`, and moving it is the first thing to do), and encryption does not happen "before anything
  leaves the executor" — it runs in the server process, after compression and before the upload,
  which is exactly why scratch and the Docker socket are in the threat model (#161).

### Fixed

- **The screen refreshes itself.** There was no `refetchInterval` anywhere and `refetchOnWindowFocus`
  was off, so a job that finished at one minute went on reading "running 47m" and the catalog stayed
  amber after the verify had turned it green. Both looked broken, and a live clock over stale data is
  worse than no clock. Now: 4 s while work is in flight, 30 s when it is not, and **no timer at all**
  while the tab is hidden. "In flight" comes from the server's counts over the whole table, never
  from the page — a ledger that went quiet because the running job fell off the two-hundred-row page
  would go quiet at the one moment it must not. Every mutation invalidates what it actually changed:
  a restore invalidated nothing before, and a green "Canary passed" could sit directly above a row
  reading "never checked" (#165).
- **The language menu changes the dates too.** Every `Intl` call passed `undefined` as the locale,
  which resolves to the **browser's** — a different setting from the app's, and the only one the menu
  does not touch. A Portuguese screen read `NÃO OBSERVADO · 2 days ago` and grouped rows under
  `HOJE` and `SEP 23, 2026`. The four date formatters now take the locale as a required first
  argument. Byte sizes, durations and server versions stay locale-independent on purpose: `850.0 KB`
  is a machine value, and a decimal comma there would be a change of meaning (#169).
- **The bootstrap finishes what a failed attempt started.** Creating the first administrator is
  three writes that cannot share a transaction, because Better-Auth writes the `User` and `Account`
  through its own adapter — so a failure between them left the organization behind and every retry
  died on the slug's unique constraint, with the setup token already spent. The organization is now
  an upsert, sign-up is skipped when the address exists, the membership is an upsert, and **the token
  is spent last**, once the administrator is real. The boot gate also counts **administrators**
  rather than users: one stray row used to close the setup link forever (#160).
- **CI can pull an S3 server again.** MinIO withdrew its community images from Docker Hub on
  2026-09-21 — the repository is gone from its API entirely — and from quay.io on 2026-09-25, which
  between them turned every open branch of this repository red at the same step, twice, for a reason
  none of them caused. The integration job and the compose smoke now pull `cgr.dev/chainguard/minio`
  **by digest**: the same upstream binary, rebuilt, served anonymously. Two fallbacks are named in
  the workflow with the date they were checked pullable, because this was the second registry move
  in five days (#163).
- **The compose smoke no longer reports a false red.** Two of its counters matched the literal
  `"VERIFIED":1`; creating a policy also dispatches its most recent past cron window, so a step that
  triggers one backup can produce two artifacts — and the detector then waited out its five-minute
  clock and failed saying nothing reached VERIFIED, above a dump in which everything had. A false red
  is worse than no check, because it teaches people to rerun (#168).
- **A restore's disabled scopes say why.** Unchanged code, but now visible: the dialog screenshot in
  `docs/backup-restore.md` shows Schema and Table carrying their reason in place of the control
  (#170).

### Installing this version

```sh
SCHRODUMP_IMAGE=schrodump/schrodump:0.1.0-rc.20
```

`latest` follows a stable tag only, and none exists yet. `:next` also moves to this candidate, which
is what `.env.example` points at until v0.1.0 ships.

## [0.1.0-rc.19] — 2026-09-21

The first pass of the pre-launch audit: thirteen pull requests (#147–#159) carrying sixteen fixes.
Several of them are defects that were live — a backup that could not run at all on a managed
database, a "sealed" destination the instance could read, a restore that silently widened.

### Security

- A **sealed destination is now actually sealed**: its artifacts are encrypted to the escrow
  recipient alone. `resolveRecipients` had always added the active operational key as well, and that
  identity sits KEK-wrapped in the metadata database — so an operator who chose sealed mode for
  custody separation got artifacts a compromised instance could open, and gave up full-restore
  verification for nothing. Artifacts written to a sealed destination before this were sealed to
  both keys and stay restorable (#156).
- **TLS to a target is verified against a CA the target carries** (`tlsCaCert`, PEM, public). `tls`
  had been a boolean the probe and the tools read differently: the probe verified strictly against
  Node's bundled CAs with no way to add one, while `pg_dump` ran `sslmode=require` and the MySQL
  clients `REQUIRED`, verifying nothing — and the Mongo tools never ran at all, because the adapter
  emitted `--tls`, which `mongodump` 100.x rejects. One reading now decides the mode for the probe
  and every descriptor alike (#158).
- **A verify or restore sandbox's volume goes with its container.** The anonymous volume held the
  restored database in clear on the host after the container was gone (#150).
- Test fixtures, design previews and documentation **name no real organization**: a real name,
  internal hostnames, production database names and an address that looked like a person's were
  replaced with neutral ones (#157).

### Fixed

- **A PostgreSQL backup taken by a role that is not a superuser now succeeds.** Every postgres
  backup also runs `pg_dumpall --globals-only`, which reads role password hashes from `pg_authid` —
  and only a superuser may. So the first backup of every managed PostgreSQL (RDS, Aurora, Cloud SQL,
  Azure, Supabase, Neon, DigitalOcean, Heroku, Aiven) and of every least-privilege role failed with
  `permission denied for table pg_authid`. The probe now asks `has_table_privilege` and the globals
  are dumped with `--no-role-passwords` when the answer is no. What was captured is recorded rather
  than assumed — `rolePasswordsCaptured`, on the manifest and on the artifact, shown in the
  artifact's details as a caution when the roles will restore without their passwords (#155).
- **A failed backup no longer leaves objects behind.** `discardObjects` removes every key the ports
  began writing — `artifact.bin`, `globals.bin`, `manifest.json` — when the run fails before the
  artifact row exists (#155).
- **An unreadable cron no longer stops every policy behind it.** `POST /policies` accepted any
  non-empty string, so `0 0 30 2 *` answered 201 and then threw inside `dispatchDueJobs` on every
  tick — unscheduling every policy listed after it, in every organization, and suppressing that
  tick's notifications with it. One module now reads a cron for the route, the scheduler and the
  notifier, each policy is isolated, and the route refuses an unreadable expression with a 400
  naming the field (#154).
- **A schedule runs on the instance's clock, and says so.** The container ran UTC and nothing passed
  a zone, so a São Paulo operator's `0 2 * * *` ran at 23:00 on their clock while the interface
  promised local time. `SCHRODUMP_TZ` (IANA name, default UTC, validated at boot) is now read
  everywhere, `nextRunAt` is computed server-side, and the policy row names the zone (#154).
- **A SCHEMA restore never widens.** A SCHEMA target naming no schema — which is every target
  created through the interface, since the form never set one — emitted no `-n` and ran
  `pg_restore --clean` over the whole database under a SUCCEEDED job. It is now refused
  (`POSTGRES_RESTORE_SCHEMA_REQUIRED`) (#152).
- **The restore dialog says where it writes**, and withholds the scopes the artifact cannot honour
  with the reason (#152).
- **A MySQL/MariaDB target is staged only when it names exactly one database.** `mydumper -B` copies
  one database by name, and for an unscoped target that name was `mysql`, the system schema: the job
  SUCCEEDED over an artifact holding no user data, and reached VERIFIED because an unscoped MySQL
  full-restore verify downgrades to a checksum. Such a target now streams, whatever the policy asks,
  and the job's reason says why (#151).
- **Retention never deletes a policy's newest VERIFIED artifact**, whatever the counters say — when
  verifies start failing, the newer copies pushing it out of the window are exactly the ones that
  cannot restore (#149).
- **The README quick start works exactly as written**, start to finish, on an empty host (#148).
- **A sealed artifact's refusal names a procedure that exists.** The restore of an artifact the
  server holds no identity for failed with "supply an identity in memory" — no such input exists
  anywhere, so the one instruction an operator got mid-incident was a dead end. It now points at the
  escrow-identity restore written up in `docs/backup-restore.md` (#159).

### Changed

- **A new policy verifies by restoring.** The server default and the form default moved from
  `CHECKSUM` to `FULL_RESTORE`, so VERIFIED means what the README says it means. A checksum is still
  a per-policy choice, and where a full restore cannot run the verify downgrades and records that it
  did, rather than producing a false green (#153).
- CI: MinIO is pulled from quay.io, and the smoke queue is drained before the stack is recreated
  (#147).

## [0.1.0-rc.18] — 2026-09-10

### Added

- A notification channel can subscribe to **every job state change**, not only to the fleet-level
  open questions (#145).

### Fixed

- `VERIFICATION_BEHIND` could never fire: the snapshot anchor was refreshed on every evaluation, so
  the unobserved count never had a gap to fail to come down across (#146).

## [0.1.0-rc.17] — 2026-09-10

### Added

- SMTP notifications can reach **a relay behind a private CA**, and CI proves an email actually
  arrives (#144).
- A channel nobody has watched deliver is shown as an open question rather than as a working
  channel; a delivery failure is recorded on the channel itself (#143).

### Fixed

- A refused request **names the field it refused** instead of returning one sentence for every
  reason (#142).

### Changed

- First import of the web design system into Claude Design (#141).

## [0.1.0-rc.16] — 2026-09-09

### Fixed

- **Every PostgreSQL dump went out schema-scoped, so `pg_dump` left extensions behind.** The probe
  lists every non-system schema and the worker fed that to the adapter, which turns each into `-n`;
  `-n` dumps only objects *in* those schemas, and extensions are database-level. A database using
  `citext` produced an artifact that restores with `type "public.citext" does not exist`, under a
  SUCCEEDED backup. Found in production. The dump is now the whole database unless an operator
  scoped the target (#139).
- A modal's clicks stay inside the modal — the portal alone never escaped the row's
  `preventDefault` (#140).

## [0.1.0-rc.15] — 2026-09-09

### Fixed

- A FAILED verify **says what the restore said**, rather than one sentence for every failure. This
  is what let the extension defect above be read at all (#138).

## [0.1.0-rc.14] — 2026-09-09

The design-system pass: every screen rebuilt on shared tokens and semantic components.

### Added

- Design-system foundations — tokens, fonts and the semantic components (#124).
- Every screen moved onto them: the artifact catalog and its dialogs (#126), the jobs ledger (#128),
  the target form and list (#129), destinations, policies and channels (#130), sign-in, setup, the
  bootstrap wall, the guided card and settings (#131), the dashboard and the audit trail (#132), the
  top bar with a theme toggle (#133), an account menu with language and theme (#134), the ruled
  lists in a card (#135).
- The artifact catalog **leads with the figure**, names the oldest open question, and is the home
  screen (#137).
- The API names what an artifact is — its target and its policy (#125) — and the jobs ledger names
  what a run touched, counting over the whole table rather than the page (#127).
- The Schrodump brand mark, favicon and header logo (#121).

### Changed

- A verify that **could not run** is INCONCLUSIVE, not FAILED — the artifact stays amber instead of
  being condemned by a missing sandbox (#122).

### Security

- `next` bumped to 16.3.4 for two critical advisories (#123).

## [0.1.0-rc.13] — 2026-09-08

### Fixed

- The delete and restore confirmations are driven from `onClick` rather than the form's submit,
  which never fired under Next 16 / React 19.

## [0.1.0-rc.12] — 2026-09-08

### Fixed

- The delete/restore dialog's submit was swallowed by the row's `preventDefault` wrapper.

## [0.1.0-rc.11] — 2026-09-08

### Added

- An operator can **delete an artifact**, with restore's friction.
- The audit trail the server had always kept becomes a page an admin can read.
- A job row shows how long it ran, how long it waited, and how it ended.
- An artifact row shows the data it had been dropping, and times in the viewer's zone.
- A target or destination row shows the scope, the probe's reason, and where the bucket lives.

## [0.1.0-rc.10] — 2026-09-08

### Added

- **A green says whether a restore proved it or only a checksum did.** A checksum-only VERIFIED is
  labelled as such beside the badge, everywhere it appears.

### Fixed

- `docs/backup-restore.md`: the MongoDB rehearsal is `mongorestore`, not `rehearse-recovery.sh`.

## [0.1.0-rc.9] — 2026-09-07

### Fixed

- **The socket proxy cut any backup or verify running longer than ten minutes**, in the shipped
  deployment.

### Added

- A target's scope is chosen from what the server actually holds, and refused when the combination
  cannot work.

## [0.1.0-rc.8] — 2026-09-07

### Fixed

- **An unscoped PostgreSQL target dumped the maintenance database and called it 9.4 GB.**
  `pg_dump` copies one database per run — the one the connection is open to — and an unscoped target
  connects to `postgres`. On a real deployment a 9.4 GB database became an 876-byte artifact under a
  SUCCEEDED job, displayed at the probe's server-wide estimate. Now refused before any container
  starts, naming the databases being left behind.

## [0.1.0-rc.7] — 2026-09-07

### Fixed

- **A broken stream was closing cleanly and being called a successful backup.**

## [0.1.0-rc.6] — 2026-09-07

### Fixed

- Nothing between the Docker socket and the uploader ever said stop, so a failure upstream did not
  abort the upload.

### Added

- A job row says which database it is about.

## [0.1.0-rc.5] — 2026-09-07

### Fixed

- **An executor's stdout is the artifact, and Docker was keeping a copy of it** — the container log
  grew to the size of every dump.

## [0.1.0-rc.4] — 2026-09-06

### Fixed

- Four of the five ways a verify goes INCONCLUSIVE explained nothing.
- A stable release would have announced whatever landed after the last candidate, rather than the
  whole cycle.
- A verify that could not run read, in the smoke, like a verify that condemned the artifact.

### Changed

- The security policy offered two reporting channels and neither one worked.
- The first thing a contributor read asked for a CLA that does not exist — the DCO had already
  replaced it (#43).
- The issue templates ask for what triage needs rather than what is easy to type.
- The advisory gate tells an outage apart from a vulnerability.
- `CONTRIBUTING.md` gains the soak: the CI gate cannot prove elapsed time, so a stable tag waits for
  a run on real wall clock — and how long that takes is a choice, which one daily policy makes the
  slowest possible one.
- `docs/roadmap.md` records that a cron window passing while the server is down leaves no trace.

## [0.1.0-rc.3] — 2026-09-03

### Added

- The dashboard **leads with the open question**, and the job list says what happened.
- The artifact catalog reads in two tiers instead of nineteen fields at once.
- The list screens are lists, and a recorded check shows where it is looked for.
- Measured tokens, a dark theme that can actually reach the page, and a badge that survives
  greyscale.

## [0.1.0-rc.2] — 2026-09-03

### Added

- Members: a deployment can have more than one person in it.
- The instance panel reports what this deployment actually booted with.
- The image and every artifact name the build that made them.
- The setup canary and probe are remembered, so the guided checklist can close.

### Fixed

- **A MySQL script that carries several databases cannot be aimed at one.** Measured on MySQL
  8.4.10: two databases dumped together, the script restored "into" the first, and the second lost
  a row with the client exiting 0.
- The facts a manifest carries must survive a catalog rebuild.
- The MongoDB scope error named a remedy that had stopped working (#90).
- `onlyBuiltDependencies` was being silently ignored.

## [0.1.0-rc.1] — 2026-09-02

First tagged release. Everything before it is the initial build of the product, which is too long to
enumerate usefully; what it amounts to is:

### Added

- **The ternary artifact state** — VERIFIED / UNOBSERVED / FAILED, with no "OK" — in the domain, the
  API and the interface.
- **Verification by restore**: a `FULL_RESTORE` verify stands an ephemeral database of the right
  version up, restores into it and asserts a non-empty schema; a checksum is the cheaper
  alternative; a verify that could not run is INCONCLUSIVE rather than a verdict.
- **Backup execution** for PostgreSQL, MySQL/MariaDB and MongoDB, in STREAM and STAGED modes,
  through ephemeral Docker executors carrying the client of the right major version — the server
  image ships none.
- **Restore execution**, role-gated and scoped where the engine provides a mechanism: PostgreSQL to
  a schema or a table, MongoDB to a database or a collection.
- **A MongoDB replica set is dumped with its oplog**, the fact is recorded on the artifact, and a
  full-cluster restore replays it, so every collection lands on one instant (#85, #86, #87).
- **S3-compatible storage** with multipart upload, a manifest sidecar, a put/get/delete canary and a
  catalog rebuild from the bucket alone.
- **Client-side encryption** to two `age` recipients (operational + escrow), envelope-encrypted
  credentials under a KEK whose fingerprint is pinned at first boot, and key rotation that strands
  no artifact (#41).
- **Application-side GFS retention**, chained to a successful backup of the same policy.
- **A cron scheduler** with an advisory lock and per-window idempotency, and a job worker claiming
  with `FOR UPDATE SKIP LOCKED`, recovering orphans at boot and draining on SIGTERM.
- **Notifications** on what the fleet has not proven — over webhooks (#22) and SMTP (#25), signed,
  firing on transition and resolving with a closing message.
- **Self-backup of the metadata catalog**, sealed to the escrow key and refusing to run without one
  (#28), plus `scripts/rehearse-recovery.sh`, which restores it using nothing from the product
  (#42), and `scripts/check-kek.mjs` (#70).
- **The art. 37 audit trail**, recording every credential read (#34, #49).
- **A Next.js dashboard** in English, Portuguese and Spanish, with guided onboarding and a typed
  confirmation on any destructive act.
- **The delivery pipeline**: a multi-stage production image, pinned executor images, a signed
  multi-arch release with an SBOM, and a compose smoke that drives the shipped stack end to end
  (#65, #66, #67).

### Fixed

Before the tag, the compose smoke found what no descriptor test could see: `schrodump/mydumper`
could not authenticate to any MySQL 8.x (#76), a STAGED MySQL artifact verified and then failed the
restore that mattered (#78), no MariaDB 11 artifact could ever be verified (#79), a STAGED PostgreSQL
backup could never be verified or restored (#80), and retention was deleting two thirds of every
backup, orphaning the role password hashes outside the configured window (#81).

[Unreleased]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.20...HEAD
[0.1.0-rc.20]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.19...v0.1.0-rc.20
[0.1.0-rc.19]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.18...v0.1.0-rc.19
[0.1.0-rc.18]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.17...v0.1.0-rc.18
[0.1.0-rc.17]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.16...v0.1.0-rc.17
[0.1.0-rc.16]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.15...v0.1.0-rc.16
[0.1.0-rc.15]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.14...v0.1.0-rc.15
[0.1.0-rc.14]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.13...v0.1.0-rc.14
[0.1.0-rc.13]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.12...v0.1.0-rc.13
[0.1.0-rc.12]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.11...v0.1.0-rc.12
[0.1.0-rc.11]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.10...v0.1.0-rc.11
[0.1.0-rc.10]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.9...v0.1.0-rc.10
[0.1.0-rc.9]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.8...v0.1.0-rc.9
[0.1.0-rc.8]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.7...v0.1.0-rc.8
[0.1.0-rc.7]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.6...v0.1.0-rc.7
[0.1.0-rc.6]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.5...v0.1.0-rc.6
[0.1.0-rc.5]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.4...v0.1.0-rc.5
[0.1.0-rc.4]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.3...v0.1.0-rc.4
[0.1.0-rc.3]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.2...v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/schrodump/schrodump/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/schrodump/schrodump/releases/tag/v0.1.0-rc.1
