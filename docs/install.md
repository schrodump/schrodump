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
`SCHRODUMP_ADMIN_PASSWORD` in `.env` before the first start.

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

> **On `SCHRODUMP_STAGED_THRESHOLD_BYTES`.** It has no default, and that is deliberate rather
> than an oversight. A STAGED dump is parallel and faster on a large database, but it needs the
> scratch volume sized for it and it writes the dump to disk in clear before uploading. Setting a
> threshold opts every database above that size into it silently; `parallelism > 1` on a policy is
> the explicit, per-policy way in, and the one to reach for first.

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

> A self-backup that says **Written** is amber in the UI, not green, and that is not an
> oversight. It means a `pg_dump` exited without complaining and nobody has restored it. The one
> way to turn it green is to do step 1 through 4 above on a spare host — which is the same thing
> this product says about every other backup it takes.

### Reaching your databases

Executors join the network named by `EXECUTOR_NETWORK`. If your databases run in Docker on the
same host, attach them to that network. If they are elsewhere, make sure the host can route to
them — the executor inherits the host's connectivity, not the server container's.

### Scratch

`STAGED` backups write the dump to `/scratch` before uploading it. **While a job runs, that
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
