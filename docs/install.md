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

| Service        | What it is                                                              |
| -------------- | ----------------------------------------------------------------------- |
| `schrodump`    | The API and the web UI                                                   |
| `db`           | PostgreSQL holding Schrodump's own metadata — not your backups           |
| `docker-proxy` | A filtered view of the Docker socket, so Schrodump can start executors   |

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

| Variable                   | Required | What it does                                              |
| -------------------------- | -------- | --------------------------------------------------------- |
| `DB_PASSWORD`              | yes      | Password for Schrodump's own metadata database             |
| `SCHRODUMP_KEK`            | yes      | Key-encryption key. See step 2                             |
| `SCHRODUMP_URL`            | no       | Public URL, used to build the setup link                   |
| `PORT`                     | no       | Host port for the web UI (default 8080)                    |
| `SCRATCH_MAX_BYTES`        | no       | Ceiling for the scratch volume (default 100 GiB)           |
| `MAX_STAGED`               | no       | How many staged backups may run at once                    |
| `EXECUTOR_NETWORK`         | no       | Docker network the executors join to reach your databases  |
| `SCHRODUMP_ADMIN_EMAIL`    | no       | Provision the first admin without the setup link           |
| `SCHRODUMP_ADMIN_PASSWORD` | no       | Same                                                       |

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
