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

Set a database password too:

```sh
openssl rand -base64 24   # -> DB_PASSWORD in .env
```

## 3. Start it

```sh
docker compose up -d
```

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

Open it and create the administrator. The token is single-use and expires; once an administrator
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

> **On `SCHRODUMP_STAGED_THRESHOLD_BYTES`.** It has no default, and that is deliberate rather
> than an oversight. A STAGED dump is parallel and faster on a large database, but it needs the
> scratch volume sized for it and it writes the dump to disk in clear before uploading. Setting a
> threshold opts every database above that size into it silently; `parallelism > 1` on a policy is
> the explicit, per-policy way in, and the one to reach for first.

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
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name schrodump.example.com;

    ssl_certificate     /etc/letsencrypt/live/schrodump.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/schrodump.example.com/privkey.pem;

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
holds. But rebuilding is a long day: it walks every object in the bucket, and until it finishes
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

If you point `SCRATCH_HOST_PATH` somewhere else, it must be a path the Docker daemon can see, and
it must be mounted at that same path inside the container. It holds dumps in clear while a job
runs — put it on an encrypted filesystem.

### Reaching your databases

Executors join the network named by `EXECUTOR_NETWORK`. If your databases run in Docker on the
same host, attach them to that network. If they are elsewhere, make sure the host can route to
them — the executor inherits the host's connectivity, not the server container's.

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

Every published image is signed. Verify before you run it:

```sh
cosign verify ghcr.io/schrodump/schrodump:<version> \
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
