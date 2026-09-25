# Installing Schrodump

From an empty host to a first verified backup. Everything runs in containers; nothing is
installed on your database servers.

## What you need

- Docker Engine 24 or newer with the Compose plugin.
- A host that can reach the databases you want to back up, and an S3-compatible bucket.
- Roughly 2 GB of RAM for Schrodump itself. Scratch space is separate and sized by your
  largest dump — see [Scratch](#scratch).

Schrodump does **not** need anything installed on the database host. Dumps run in ephemeral
containers built from the target's own major version, which is why the server image contains no
`pg_dump`, `mysqldump` or `mongodump`.

## Evaluate it first: the demo stack

Everything below assumes a bucket and a database you already have. If you have neither yet — or you
simply want to see what a `VERIFIED` badge costs before spending an afternoon on it — the repository
ships an evaluation stack that brings its own:

```sh
git clone https://github.com/schrodump/schrodump.git
cd schrodump
docker compose -f compose.demo.yaml up -d
```

`compose.demo.yaml` **includes** `compose.yaml` rather than copying it, so what you evaluate is the
deployment this project ships, not a lookalike. On top of it, it adds three services:

| Service      | What it is                                                                      |
| ------------ | ------------------------------------------------------------------------------- |
| `minio`      | An S3-compatible endpoint on the internal network, standing in for your bucket  |
| `minio-init` | One shot, as root: prepares MinIO's volume and the `backups` bucket, then exits |
| `sample-db`  | PostgreSQL 18 on the `targets` network, seeded with 8 customers and 240 orders  |

It differs from the install below in four ways, and none of them is a detail:

- **The key-encryption key and every password are in `compose.demo.env`, committed to this
  repository.** A KEK everyone has is a KEK that protects nothing: every artifact this stack writes
  can be opened by anyone who has cloned Schrodump.
- **Nothing speaks TLS** — not the UI, not the connection to MinIO, not the connection to the
  sample database.
- **The bucket is a container volume.** `down -v` destroys it and every backup in it. A real
  destination outlives the instance that wrote to it; this one does not.
- **Scratch is `/tmp/schrodump-demo/scratch`**, which is where it can be shared by Docker Desktop
  without reconfiguring it. It holds dumps in clear while a job runs, so on a server it belongs on
  an encrypted filesystem instead — see [Scratch](#scratch).

The project name is pinned to `schrodump-demo`, so the demo can never adopt or delete the volumes
of a real stack running from `compose.yaml` in the same clone.

There is no default account in the demo either. Read the one-time setup link, open it, create the
administrator, and then walk [step 5](#5-first-verified-backup) with these values — every one of
them is already running:

```sh
docker compose -f compose.demo.yaml logs schrodump | grep setupUrl
```

| Step            | What to enter                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encryption keys | Provision both, operational and escrow                                                                                                                            |
| Destination     | `http://minio:9000`, region `us-east-1`, bucket `backups`, access key `schrodump-demo`, secret `schrodump-demo`, path-style addressing **on**. Then run the canary |
| Target          | PostgreSQL, host `sample-db`, port `5432`, user `demo`, password `schrodump-demo`, TLS off. Then **Discover databases**, pick `sample`, and test the connection   |
| Policy          | Any schedule, verify level **full restore** (the default). Then **Run backup now**                                                                                |

The artifact turns `VERIFIED` in seconds once the images are local. To see that the badge is about
content rather than about a job exiting `0`, change the data and restore over it — the same
operation you would run during an incident:

```sh
docker compose -f compose.demo.yaml exec sample-db \
  psql -U demo -d sample -c 'DELETE FROM orders'
# then: Artifacts -> Restore -> Database, and type the database name to confirm
docker compose -f compose.demo.yaml exec sample-db \
  psql -U demo -d sample -tAc 'SELECT count(*) FROM orders'   # 240 again
```

Tear it down with one command. It deletes the containers, the two demo networks, Schrodump's
metadata database, the MinIO volume with every backup in it, the sample database, and the scratch
directory:

```sh
docker compose -f compose.demo.yaml down -v && rm -rf /tmp/schrodump-demo
```

Nothing else is left behind: the images are the only thing that stays on the host, and they are the
ones a real install would pull anyway.

## 1. Get the files

```sh
git clone https://github.com/schrodump/schrodump.git
cd schrodump
cp .env.example .env
```

Only `compose.yaml` and `.env` are needed to run it. The rest of the repository is the source.

## 2. Generate the key-encryption key

The KEK encrypts the keys that protect every backup. Generate it now:

```sh
openssl rand -base64 32
```

Put the value in `.env` as `SCHRODUMP_KEK`, then **store a copy somewhere else** — a secrets
manager, or an offline vault.

> **Lose the KEK and you lose every backup.** There is no recovery path, by design: a tool that
> can recover your artefacts without your key is a tool whose operator can read your data. Do not
> keep the only copy on the host that holds the data it protects. Schrodump records a fingerprint
> of the KEK on first boot and refuses to start against a different one, so a silent swap becomes
> a failed boot rather than a pile of artefacts nobody can open.

### Checking a candidate key

If you end up holding several values and are not sure which one an instance was initialized with,
you do not have to restart the stack once per guess. Read the recorded fingerprint:

```sh
docker compose exec -T db psql -qtAX -U schrodump -d schrodump \
  -c "select value from \"AppConfig\" where key = 'kek_fingerprint'"
```

and test candidates against it. The key goes in on **stdin**, never as an argument — an argument is
visible to every process on the host:

```sh
printf %s "$CANDIDATE" | node scripts/check-kek.mjs --fingerprint <the-hex-above>
```

It exits 0 on `MATCH`, 1 on `NO MATCH`, and 2 when the value is not a 32-byte key at all — so a
truncated paste is reported as a truncated paste rather than as the wrong key.

A match means the key is the one this instance recorded. It is not an independent proof that a
credential will unwrap: the fingerprint is derived from the KEK alone, so it cannot detect a
fingerprint row that was itself replaced. Booting the server is that proof, and now you only have
to do it once.

Set a database password too — in hex, not base64:

```sh
openssl rand -hex 24      # -> DB_PASSWORD in .env
```

Compose places this value unescaped inside `postgres://schrodump:<password>@db:5432/…`, and a
base64 password contains `/` roughly 40% of the time. That slash ends the URL's authority early,
Prisma reports `P1013: invalid port number`, and the first boot exits before a single request.

## 3. Start it

```sh
docker compose up -d
```

`.env.example` names `SCHRODUMP_IMAGE=schrodump/schrodump:next`, the newest release. Schrodump has
not shipped a stable version yet, and `compose.yaml`'s own default, `latest`, only exists once one
has — so leave that line in until then, and pin an exact version in production either way.

A one-shot `scratch-init` service runs first, as root, creates the scratch directory on the host
(`SCRATCH_HOST_PATH`, default `/var/lib/schrodump/scratch`) and hands it to the server's
unprivileged user. It exits, and `docker compose ps -a` lists it as `Exited (0)` — that is its
success state, not a crash. See [Scratch must be a host path](#scratch-must-be-a-host-path-not-a-named-volume)
for why the directory matters.

Three containers come up:

| Service        | What it is                                                             |
| -------------- | ---------------------------------------------------------------------- |
| `schrodump`    | The API and the web UI                                                 |
| `db`           | PostgreSQL holding Schrodump's own metadata — not your backups         |
| `docker-proxy` | A filtered view of the Docker socket, so Schrodump can start executors |

Migrations are applied by the container's entrypoint before the server accepts a request, so
there is no separate migration step.

Watch it come up:

```sh
docker compose logs -f schrodump
```

### Is it actually up?

`docker compose ps` reports the `schrodump` container's health, and that health means something:
the container's healthcheck asks the API, and the API asks PostgreSQL. A container marked
`(unhealthy)` is one whose metadata database it cannot reach — which is also the state in which
every backup job will fail, so it is worth alerting on.

```sh
curl -i http://127.0.0.1:8080/health     # 200 {"status":"ok"} — or 503 {"status":"degraded"}
```

`/health` deliberately does not say which build answered it: the endpoint needs no session, and a
version banner on it tells an unauthenticated caller which advisories apply to your deployment. Ask
the image instead — no process required — or read the first line the server logs:

```sh
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
  schrodump/schrodump:<the tag you pulled>
docker compose logs schrodump | grep 'server listening'   # {"version":"<that same tag>",...}
```

Every artifact carries the same answer for itself, in its manifest's `toolVersion` — which is the
one that matters during a recovery, when the container that wrote the backup no longer exists.

The container is deliberately **not** restarted when this goes red. A restart would abort whatever
backup is running — and with it the cleartext scratch directory that the shutdown handler would
otherwise clean up — to fix a condition that is usually a brief database blip and is not Schrodump's
to fix. The failure is reported, with a reason in the logs, and left for you.

## 4. Create the first administrator

There is no default account and no default password. On first boot Schrodump prints a one-time
setup URL:

```
setup token issued — open the URL to create the first admin
setupUrl: http://localhost:8080/setup?token=...
```

Open it — at exactly that address. Sign-in is refused from any origin other than `SCHRODUMP_URL`
(its `localhost`/`127.0.0.1` twin is accepted too), so reaching the stack through the host's IP or a
proxy name means setting `SCHRODUMP_URL` to that address first; the sign-in page names the mismatch
if you forget. Create the administrator. The token is single-use and expires; once an administrator
exists, `/setup` closes permanently and account recovery moves to the CLI.

If you prefer to provision without touching the browser, set `SCHRODUMP_ADMIN_EMAIL` and
`SCHRODUMP_ADMIN_PASSWORD` in `.env` before the first start. The password must be at least 12
characters — the same floor the server enforces on every password — and a shorter one fails the
boot with a message naming the variable rather than starting with a weak admin.

## 5. First verified backup

The dashboard walks you through it, in this order, and the order matters:

1. **Create a destination** — the S3-compatible bucket where artefacts go.
2. **Run the canary** on it. This does a real put, get and delete. Credentials that can write but
   not read produce backups you cannot restore, and the canary is how you find that out now
   rather than during an incident.
3. **Create a target** — the database to back up.
4. **Test the connection.** Schrodump probes the server version here, because the version decides
   which executor image runs the dump.
5. **Create a policy** with a verify level set. A policy with verify off produces artefacts that
   stay `UNOBSERVED` forever — they may be perfect, or empty; nothing has looked.

Then trigger a backup and wait for the verify job. A backup that has been verified shows as
`VERIFIED`. Anything else is a question, not a result — see
[backup-restore.md](backup-restore.md).

## Configuration

Everything lives in `.env`. The defaults are in `.env.example`.

| Variable                           | Required | What it does                                                                                                                     |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DB_PASSWORD`                      | yes      | Password for Schrodump's own metadata database                                                                                   |
| `SCHRODUMP_KEK`                    | yes      | Key-encryption key. See step 2                                                                                                   |
| `SCHRODUMP_URL`                    | no       | Public URL, used to build the setup link                                                                                         |
| `SCHRODUMP_TZ`                     | no       | IANA time zone every policy's cron is read in (default `UTC`). One per deployment; an unknown name stops the boot. See below      |
| `PORT`                             | no       | Host port for the web UI (default 8080)                                                                                          |
| `SCRATCH_MAX_BYTES`                | no       | Ceiling for the scratch volume (default 100 GiB)                                                                                 |
| `SCHRODUMP_STAGED_THRESHOLD_BYTES` | no       | Dumps estimated above this run STAGED. Unset by default, and read the note below before setting it                               |
| `MAX_STAGED`                       | no       | How many staged backups may run at once                                                                                          |
| `SCHRODUMP_NOTIFY_MIN_GAP_MS`      | no       | How old the previous notification snapshot must be before it anchors the "verification is falling behind" check (default 15 min) |
| `EXECUTOR_NETWORK`                 | no       | Docker network the executors join to reach your databases                                                                        |
| `SCHRODUMP_ADMIN_EMAIL`            | no       | Provision the first admin without the setup link                                                                                 |
| `SCHRODUMP_ADMIN_PASSWORD`         | no       | Same                                                                                                                             |
| `SCHRODUMP_SELF_BACKUP_DESTINATION_ID` | no   | Destination for the self-backup of Schrodump's own metadata database. Unset -> disabled. See below                               |
| `SCHRODUMP_SELF_BACKUP_INTERVAL_MS` | no      | How often to self-backup (default 24h), measured from the last successful run                                                    |
| `SELF_BACKUP_NETWORK`              | no       | Network the self-backup executor joins (default `schrodump_internal`) — not the executor network                                 |
| `SCHRODUMP_TRUSTED_PROXIES`        | no       | CIDRs of the hops in front of this server. Read the TLS section — unset behind a proxy locks out every user                      |
| `SCHRODUMP_SMTP_CA_FILE`           | no       | PEM of a CA to trust for an email notification relay whose certificate the system store does not carry. See below                |
| `SCHRODUMP_EGRESS_DENY`            | no       | CIDRs the server may **not** connect to, on top of the built-in refusals. Empty by default. See below                            |
| `SCHRODUMP_EGRESS_ALLOW`           | no       | CIDRs that override every refusal, the built-in ones included. Empty by default. See below                                       |

> **On `SCHRODUMP_STAGED_THRESHOLD_BYTES`.** It has no default, and that is deliberate rather
> than an oversight. A STAGED dump is parallel and faster on a large database, but it needs the
> scratch volume sized for it and it writes the dump to disk in clear before uploading. Setting a
> threshold opts every database above that size into it silently; `parallelism > 1` on a policy is
> the explicit, per-policy way in, and the one to reach for first. Neither applies to a mysql/mariadb
> target that is unscoped or selects several databases: a staged mysql dump (`mydumper`) copies
> exactly one database, so such a target is streamed whatever the policy asks, and the job's reason
> says so.

> **On `SCHRODUMP_TZ`.** A cron expression names a wall-clock time, so it only means something on
> a named clock. The container's clock is UTC, and it is not the one to change: the zone is
> applied where a cron is read — by the scheduler, by the notification cadence, and when a policy
> is saved. Set it to the zone your maintenance windows are planned in (`America/Sao_Paulo`,
> `Europe/Berlin`); a policy row then reads `every day at 02:00 America/Sao_Paulo` and shows the
> next run on the viewer's own clock. Changing it moves every policy's schedule at once, on the
> next restart — and the first tick after it dispatches each policy's most recent window on the
> new clock if that window has no job yet, exactly as it does for a policy just created.

> **On `SCHRODUMP_EGRESS_DENY` / `SCHRODUMP_EGRESS_ALLOW`.** Four fields in the interface name an
> address Schrodump then connects to — a webhook URL, an S3 endpoint, an SMTP relay, a database
> target's host — and each of them tells you whether something answered. With both variables unset
> the server refuses only what can never be a legitimate destination: loopback, link-local
> (`169.254.169.254` is the cloud metadata service), the unspecified address, and **this
> deployment's own services** (`db`, `docker-proxy` and the API itself, by name and by the address
> they resolve to). **Your private network is deliberately left alone** — a database on `10.0.0.5`
> or a MinIO on `192.168.1.10` is the normal shape of a self-hosted install, and refusing it by
> default would break more deployments than it protected. If every database you back up is public,
> or is reached only by the executors on their own network, you can shut the private ranges:
> `SCHRODUMP_EGRESS_DENY=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7`. `..._ALLOW` overrides
> every refusal, including the built-in ones; the case it exists for is a deployment whose metadata
> PostgreSQL also holds a database you back up. Both take a comma-separated list of CIDRs (a bare
> address means that one host), and an entry that is neither stops the boot naming the variable.
> [security.md](security.md#what-the-server-will-and-will-not-connect-to) states exactly what is
> refused, and what this does and does not protect against.

### Email notifications to an internal relay

Email is always sent over TLS, with strict certificate verification, and there is no switch to turn
that off. Against a public relay — SES, SendGrid, Fastmail, Gmail — nothing needs configuring: the
certificate chains to a CA the image already trusts.

An **internal relay signed by your own CA** is the case that needs a line. Without it the delivery
fails at the TLS handshake, the channel records the failure, and no email arrives.

Mount the CA bundle and point the server at it:

```yaml
services:
  schrodump:
    volumes:
      - ./internal-ca.pem:/etc/schrodump/smtp-ca.pem:ro
```

```
SCHRODUMP_SMTP_CA_FILE=/etc/schrodump/smtp-ca.pem
```

It **adds** a CA to the trust set; it never removes one, and it is not a way to skip verification.
A relay whose certificate does not verify against the system store *or* this file is still refused
— sending the fleet's state in the clear to whoever answers on that port is not a tradeoff the
product offers.

The file is read once, at boot: a deployment that changes it has to restart to pick it up.

> **Prove it before you rely on it.** A channel that has been configured and never carried a
> message reads **UNOBSERVED** — amber, not green — because it may be perfect or it may be silently
> broken, and nothing yet distinguishes the two. **Send test** on the channel delivers for real and
> reports what happened. Do that once after configuring, and again after changing the relay.

### Getting every job, not only the fleet's open questions

A channel receives the three fleet alerts by default — an artifact that failed verification,
verification falling behind, a policy gone quiet. It deliberately does **not** fire on a job that
ran, because a channel that fires on every job is a channel filtered into a folder within a week,
and the three alerts that matter are filtered with it.

If you want the stream anyway — validating a fresh deployment, feeding a dashboard, keeping a
record outside the database — tick **Also send every job state change** when creating the channel.
That channel then receives one delivery per transition: `PENDING`, `RUNNING`, and the terminal
state, for every backup, verify, restore and retention job.

Each delivery carries the job as structured fields rather than only as prose, so a receiver routes
on them instead of parsing a sentence:

```json
{ "trigger": "JOB_STATE",
  "key": "<jobId>",
  "kind": "occurred",
  "summary": "BACKUP job for policy \"shop-daily\" is RUNNING",
  "job": { "id": "…", "kind": "BACKUP", "state": "RUNNING", "policyId": "…" } }
```

The `Idempotency-Key` header is distinct per transition, so a receiver that deduplicates keeps all
three rather than collapsing them into one. Existing channels are unaffected: the option is off
unless it is chosen.

### Upgrading

```
git pull
docker compose pull
docker compose up -d
```

Schema migrations run from the entrypoint on start (`prisma migrate deploy`), so there is no
separate step. Take a copy of the metadata database first — or, better, configure the self-backup
below so one already exists.

**Breaking change, unreleased:** the published port now binds to `127.0.0.1` instead of every
interface. An installation that was reached directly at `http://host:8080` will stop answering
after this upgrade. That is the point — see the section below — and the fix is to put a reverse
proxy in front. To defer it, set `PUBLISH_ADDR=0.0.0.0` in `.env` and understand that the session
cookie crosses the network in clear.

### Generate the encryption keys. Nothing works before this.

Every artefact is sealed to **two** recipients, and a backup will not run until both exist. Settings
-> Encryption keys, as an admin, before creating anything else — the guided setup puts it first for
this reason.

| | Who holds the private half | What it is for |
| --- | --- | --- |
| **Operational** | The server, wrapped with the KEK | Verify and restore, without fetching anything from a safe |
| **Escrow** | **You, offline** | The key that survives losing the metadata database |

The escrow private identity is shown **exactly once**, in the response to its own creation, and is
stored nowhere — not on the server, not in the browser. Save it somewhere that is not this host
before dismissing the screen. Without it a self-backup can never be recovered, and a self-backup is
precisely the thing you reach for after the metadata database is gone.

If you already keep age keys offline, use the second option and paste your own **public recipient**
(`age1…`) instead. The private half then never reaches the server at all, which is the stronger
posture. The recipient is validated by age itself, checksum included, so a transposed character is
refused here rather than discovered later as an artefact nobody can open.

Both keys are provisioned once. There is no rotation yet — retiring a key while old artefacts stay
readable is a separate operation and is not implemented, so the request is refused rather than
quietly issuing a second active key.

### Put it behind TLS. This is not optional.

Schrodump serves plain HTTP on port 8080 and authenticates with a **session cookie**. Published
directly, every login and every request after it carries that cookie across the network in clear.
Anyone positioned in between reads it and becomes the operator — and this particular operator can
read every target's connection details and start a restore over a live production database.

Do not publish 8080 to anything but loopback. Terminate TLS in front of it.

**Caddy** (obtains a certificate on its own):

```
schrodump.example.com {
    reverse_proxy 127.0.0.1:8080
    # HSTS belongs here, not in the application — see below.
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name schrodump.example.com;

    ssl_certificate     /etc/letsencrypt/live/schrodump.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/schrodump.example.com/privkey.pem;

    # HSTS belongs here, not in the application — see below.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SET, not append. $proxy_add_x_forwarded_for carries through whatever the client sent in
        # its own X-Forwarded-For, and a client that writes its own address into that header picks
        # its own rate-limit bucket. $remote_addr is the one value nginx observed for itself.
        proxy_set_header X-Forwarded-For   $remote_addr;
    }
}
```

Then bind the published port to loopback in `compose.yaml` — `"127.0.0.1:${PORT:-8080}:8080"` — so
the proxy is the only way in.

#### HSTS is yours, the rest is ours

Schrodump sends the browser-side headers itself — `Content-Security-Policy` with
`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`, on the UI and on the API alike
([security.md](security.md#a-signed-in-operator-is-one-framed-click-from-a-restore)). You do not
have to add them at the proxy, and a second `Content-Security-Policy` is worse than none: a browser
enforces every policy it is sent, so the rule that actually applies becomes the intersection of
yours and ours, and it moves under you whenever either side changes. If you do add headers of your
own, note that nginx inherits `add_header` from an outer block only while the inner one declares
none: a single `add_header` inside `location /` silently drops the `server`-level lines above it.

`Strict-Transport-Security` is the exception, and it is deliberately not sent by the application.
This container listens on plain HTTP: it cannot promise a browser that the hostname is reachable
over TLS, and a `max-age` emitted from an installation that is later reached over HTTP locks
people out of their own backups for a year. The proxy is the only component that knows TLS is
really there, so the two snippets above send it.

#### Then tell Schrodump about the proxy

```
SCHRODUMP_TRUSTED_PROXIES=127.0.0.1/32
```

List every hop in front of the server. `127.0.0.1/32` covers the UI's internal rewrite, which is
always present in the shipped image; add your proxy's address if it reaches the container from
anywhere else.

**Leaving this unset behind a proxy fails in the direction you would not guess.** The login rate
limit buckets by client address. With a proxy in front, `X-Forwarded-For` arrives carrying more
than one entry, and with nothing trusted the server will not guess which entry is the client — so
every request in the deployment lands in *one shared bucket*. One operator fat-fingering their
password five times then locks everybody else out of the login page. That is measured, not
reasoned: `apps/server/src/auth/rate-limit.integration.test.ts` asserts a second, unrelated client
address stays in its own bucket, and that assertion fails the moment the setting is removed.

Unset with **no** proxy in front is the opposite failure. `X-Forwarded-For` is then whatever the
client chose to send, and an attacker who changes it on every request gets a fresh bucket each
time and is never limited at all.

### Backing up Schrodump itself

Every artifact in the bucket carries a manifest written in clear beside it, so the catalog can
always be rebuilt from the bucket alone (Settings -> catalog rebuild). That is the floor, and it
holds — including when the loss is only partial, and including when you run it twice: importing is
idempotent, and a rebuilt artifact comes back **UNOBSERVED**, never VERIFIED. The verification
record lived in the database that was lost, and a rebuild does not get to inherit a green state it
cannot substantiate. But rebuilding is a long day: it walks every object in the bucket, and until it finishes
you cannot answer "which backups do I have".

A self-backup makes that a short day instead. Point it at a destination:

```
SCHRODUMP_SELF_BACKUP_DESTINATION_ID=<id of an existing destination>
```

Unset, there is no self-backup, and the server logs a warning saying exactly that at boot. The
variable has no default on purpose — the metadata database holds every target's wrapped
credential, so which bucket it lands in is a decision you make deliberately, not one inferred
from whichever destination happens to be first.

**It requires an active escrow key, and refuses to run without one.** This is the part worth
reading twice. The operational key's identity is stored, KEK-wrapped, *inside the metadata
database*. In the disaster a self-backup exists for — that database is gone — the operational
identity went with it. The only key that can open a self-backup is the **offline escrow
identity**. An organization with no escrow key would get an artifact nobody could ever decrypt, so
the run fails with that reason instead of writing a decoy.

The self-backup executor joins `schrodump_internal`, not the target network. The metadata database
is deliberately unreachable from the network that talks to your databases, and this is the one
dump that has to cross that line — for its own duration and nothing else.

#### Recovering from one

Beside the artifact is `self-backup.json`, written in clear, listing the bucket key, the checksum
and the recovery steps. The procedure:

1. Fetch `metadata.bin` and `self-backup.json` from the bucket.
2. Decrypt with the **offline escrow age identity** — not the operational one.
3. `gunzip`, then `pg_restore` into an empty database.
4. Point `DATABASE_URL` at it and start Schrodump.

Everything in the bucket is addressable again at that point. Verify the checksum in the sidecar
against what you fetched before restoring.

Steps 2 and 3 are covered by a drill that runs in CI
(`apps/server/src/jobs/self-backup-recovery.integration.test.ts`): it takes a real `pg_dump` of a
real Schrodump schema using the same descriptor the backup path builds, seals it with the
production encrypt pipeline to an escrow-only recipient, then decrypts, gunzips and `pg_restore`s
it into an empty database and checks the catalog came back. It also asserts the operational
identity **cannot** open it.

A second drill (`self-backup-e2e.integration.test.ts`) covers steps 1 and 4 as well. It drives the
scheduler tick itself against a real Postgres on a Docker network, a real ephemeral executor and a
real S3 bucket, then downloads the object, decrypts it with the escrow identity and restores it —
and checks that the recovered catalog knows about the self-backup it came from. Pointing the
executor at the wrong network turns all four of its assertions red, which is the property that
matters: the metadata database is not reachable from the target network, on purpose.

What neither drill can cover is your own topology — that your reverse proxy, your bucket and your
`internal` network are wired the way you think they are. **Rehearse the recovery once against a
spare host before you need it.** That is the step that turns a self-backup from written into
verified, and nothing in CI can do it for you.

`scripts/rehearse-recovery.sh` is that rehearsal, and it deliberately uses nothing from Schrodump —
`aws`, `age`, `gunzip`, `pg_restore`. On the day you need this, Schrodump is the thing that is gone,
and a procedure that depends on it is not a procedure:

```sh
scripts/rehearse-recovery.sh \
  --bucket my-backups --sidecar schrodump/self-backup/<id>/self-backup.json \
  --identity ./escrow.key \
  --into 'postgresql://postgres:postgres@127.0.0.1:5433/rehearsal'
```

It is read-only against the bucket, refuses to write into a database that already holds tables,
verifies the sidecar checksum before decrypting, deletes the cleartext dump on every exit path, and
finishes by counting the organizations, targets and artifacts it recovered. That the artifact opens
with the plain `age` binary at all is itself asserted in CI
(`apps/server/src/crypto/age-cli-interop.integration.test.ts`) — otherwise these instructions would
be a claim nobody had checked.

> A self-backup that says **Written** is amber in the UI, not green, and that is not an
> oversight. It means a `pg_dump` exited without complaining and nobody has restored it. The one
> way to turn it green is to do step 1 through 4 above on a spare host — which is the same thing
> this product says about every other backup it takes.

### Scratch must be a host path, not a named volume

`SCRATCH_HOST_PATH` (default `/var/lib/schrodump/scratch`) is bind-mounted into the container **at
the same absolute path**, and that is load-bearing rather than tidy.

Executors mount files out of scratch — the decrypted artifact for a restore, the staging directory
for a STAGED dump, the `--config` file mongo's password travels in — and the bind source of those
mounts is resolved by the **Docker daemon, on the host**. A named volume mounted at `/scratch`
hands the daemon a path that exists only inside Schrodump's own container, and it answers:

```
mounts denied: The path /scratch/... is not shared from the host and is not known to Docker
```

STREAM backups keep working, because nothing is mounted for them — the dump goes out on stdout. So
the failure looks like "backups fine, verify broken", which is the worst possible shape for this
product: artifacts accumulating that nothing can ever check. Verified end to end on a composed
stack; with the path matched, a backup and its chained `FULL_RESTORE` verify both succeed and the
artifact reaches `VERIFIED`.

**It must be writable by the container's user, which is uid 100.** A named volume is chowned by
Docker; a bind mount is not, so a directory created as root is one the server cannot write — and
the failure is quiet in the worst way: STREAM backups keep succeeding while verify, restore, STAGED
and every mongo job fail, because only those mount anything. The server refuses to boot rather than
let that happen. The shipped `compose.yaml` takes care of it with the one-shot `scratch-init`
service, which runs as root before the server and chowns the directory to the server's user. If you
run the image some other way (Kubernetes, a hand-written unit), do the same yourself:

```sh
sudo mkdir -p /var/lib/schrodump/scratch
sudo chown -R 100 /var/lib/schrodump/scratch
```

If you point `SCRATCH_HOST_PATH` somewhere else, it must be a path the Docker daemon can see, it
must be mounted at that same path inside the container, and it must be owned by uid 100 (again,
`scratch-init` does this for any path you set). It holds dumps in clear while a job runs — put it
on an encrypted filesystem.

### MongoDB targets need a narrow credential

Point Schrodump at MongoDB with a root user and the first backup fails. That is correct behaviour
and it is worth understanding before it happens.

Schrodump dumps the databases the target's credential can see, and `mongodump` takes one database
per invocation. A root user can list `admin`, `config` and `local` alongside yours, so the dump has
no unambiguous subject and is refused rather than guessed at.

Create a user restricted to the database you are backing up:

```js
db.getSiblingDB("admin").createUser({
  user: "backup",
  pwd: "<password>",
  roles: [{ role: "readWrite", db: "shop" }],
})
```

`listDatabases` then returns only `shop`, the connection test passes, and the dump is unambiguous.
Authenticate against `admin` (where the user lives) and set the target's scope to `shop`.

One user per database you back up. That is more setup than a single root credential, and it is the
same posture the rest of this tool takes: the thing holding your credentials should hold the
narrowest ones that work.

### PostgreSQL targets: what the backup role needs

A PostgreSQL backup does not need a superuser, and on a managed service (RDS, Aurora, Cloud SQL,
Azure, Supabase, Neon, DigitalOcean, Heroku, Aiven) it cannot have one. What it needs is to read
every object in the database it dumps:

```sql
CREATE ROLE schrodump_backup LOGIN PASSWORD '<password>';
GRANT CONNECT ON DATABASE shop TO schrodump_backup;

-- PostgreSQL 14 and later: read every table, view and sequence, in every schema, including
-- the ones created after today.
GRANT pg_read_all_data TO schrodump_backup;

-- PostgreSQL 13 has no pg_read_all_data. Grant per schema, and repeat for each one:
GRANT USAGE ON SCHEMA public TO schrodump_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO schrodump_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO schrodump_backup;
-- ...and for tables created later (run as the role that will create them):
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO schrodump_backup;
```

A table the role cannot read fails the dump — with `pg_dump`'s own message in the job's reason —
rather than being left out of it. Leave `CONNECT` on the server's other databases with `PUBLIC`,
where PostgreSQL puts it: the connection test measures the size of every database on the server,
which needs it, and the roles are dumped over a connection to the `postgres` maintenance database.
On a server that revoked it, the connection test is where that shows.

**What a non-superuser does not get is role passwords.** Every PostgreSQL backup also dumps the
roles, memberships and tablespaces (`globals.bin`), and the password hashes among them live in
`pg_authid`, which only a superuser can read. Schrodump asks the server which one it is talking to
before the dump runs: a superuser's backup carries the hashes, anyone else's is taken with
`--no-role-passwords`, and the artefact records which — **Role passwords: not captured** in its
details. Restoring those roles onto a fresh server creates them without passwords; set them
afterwards. [backup-restore.md](backup-restore.md#what-logical-backups-do-not-cover) has the
details.

### Reaching your databases

Executors join the network named by `EXECUTOR_NETWORK`. If your databases run in Docker on the
same host, attach them to that network. If they are elsewhere, make sure the host can route to
them — the executor inherits the host's connectivity, not the server container's.

### Managed databases: paste the provider's CA

"Require TLS" on its own **encrypts without verifying** the server's certificate for PostgreSQL,
MySQL and MariaDB (MongoDB verifies against the system trust store). Paste the CA certificate that
signed the server's certificate into the target's **CA certificate** field and every connection —
the test, each backup, each restore — verifies the chain against it and checks the host name.
[security.md](security.md#the-connection-to-your-database-and-what-each-tls-mode-verifies) states
exactly what each mode checks. Run **Discover** after pasting: it connects with the CA, so a wrong
one is caught before anything is saved.

| Provider                     | What to paste                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS RDS / Aurora             | The bundle for the instance's region, `https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem` (about 4.5 KB). The global bundle works too — 108 certificates, ~165 KB, under the 256 KiB cap. |
| Google Cloud SQL             | The instance's server CA: Cloud SQL → the instance → **Connections → Security → Download server CA certificate** (`server-ca.pem`), or `gcloud sql instances describe <instance> --format='value(serverCaCert.cert)'`. |
| Supabase                     | Project Settings → Database → **SSL Configuration → Download certificate** (`prod-ca-2021.crt`).                                                                                            |
| DigitalOcean Managed         | The cluster's **Connection details → Download CA certificate** (`ca-certificate.crt`).                                                                                                      |
| Aiven                        | The service overview's **CA certificate** (`ca.pem`).                                                                                                                                       |
| Self-signed / your own CA    | The CA certificate — not the server's certificate unless it is self-signed, and **never its private key** (the API refuses one).                                                          |

Use the **host name on the certificate** (the provider's endpoint), not an IP address: verification
checks the name, and a certificate rarely names an address.

Three things follow from pasting one:

- **Scratch is required.** The tools read the CA from a file bind-mounted from
  `SCHRODUMP_SCRATCH_PATH` (the default compose file sets it).
- **Turning TLS off is not the fix for a TLS failure.** Where the provider enforces TLS (RDS
  PostgreSQL 15+ sets `rds.force_ssl`) it is refused anyway, and where it is not, the password and
  every dump cross the network in the clear.
- **A staged MySQL/MariaDB policy needs the CA to stay staged.** Without one, a TLS target streams:
  `mydumper` cannot require TLS without verifying it.

### Scratch

`STAGED` backups write the dump to the scratch directory before uploading it. **While a job runs, that
directory holds your data in clear** — the compression and encryption happen on the way out. Give
it a dedicated volume on an encrypted filesystem. This is the operator's job, not Schrodump's;
[security.md](security.md#scratch-holds-your-data-in-clear) explains why.

Size it for your largest single dump, times `MAX_STAGED`.

## Upgrading

```sh
docker compose pull
docker compose up -d
```

Migrations run automatically on start. For production, pin the image to an exact version in
`compose.yaml` rather than tracking `latest`, so that an upgrade is something you decide and not
something a `pull` decides for you.

Every published image is signed. Verify before you run it — **with cosign v3 or newer**:

```sh
cosign version   # must be 3.x
```

> **A v2 client reports `Error: no signatures found` on these images, and that is not what it
> sounds like.** The release signs with cosign v3, whose default is the OCI 1.1 bundle format
> rather than the legacy `<digest>.sig` tag a v2 client looks for. So v2 cannot see a signature
> that is there — and on a supply-chain check, "no signatures found" is indistinguishable from an
> unsigned image. If your package manager still ships v2, take the binary from
> [the cosign releases page](https://github.com/sigstore/cosign/releases) instead.

```sh
cosign verify ghcr.io/schrodump/schrodump:<version> \
  --certificate-identity-regexp '^https://github.com/schrodump/schrodump/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The executor images are signed the same way, and they are the ones worth checking: you never type
their names. The server resolves `schrodump/mydumper:1` — a floating tag — by itself at backup
time, pulls it, and hands the container a target database's password.

```sh
cosign verify ghcr.io/schrodump/mydumper:1 \
  --certificate-identity-regexp '^https://github.com/schrodump/schrodump/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Uninstalling

```sh
docker compose down          # keeps the volumes
docker compose down -v       # deletes the metadata database and scratch
```

`down -v` destroys Schrodump's catalogue, not your artefacts — those live in your bucket. A
catalogue can be rebuilt from a destination; the KEK cannot be rebuilt from anything.
