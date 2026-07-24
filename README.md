<div align="center">

# Schrodump

**Verified logical backups for PostgreSQL, MySQL/MariaDB and MongoDB.**

A backup a restore hasn't proven isn't a backup — it's a guess.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22-brightgreen.svg)](.nvmrc)
[![CI](https://github.com/schrodump/schrodump/actions/workflows/ci.yml/badge.svg)](https://github.com/schrodump/schrodump/actions/workflows/ci.yml)
[![Security](https://github.com/schrodump/schrodump/actions/workflows/security.yml/badge.svg)](https://github.com/schrodump/schrodump/actions/workflows/security.yml)

**English** · [Português](README.pt-BR.md) · [Español](README.es.md)

</div>

---

## Why Schrodump

A backup job that exits `0` has proven one thing: a process ran without complaining. It has **not**
proven the file in your bucket contains your data. Credentials that can write but not read, a dump
truncated when a connection dropped, a retention rule that deleted the last good copy — all of them
produce a green job and an unusable artifact, observable only at restore time.

So Schrodump refuses to call a backup good because a job succeeded. Every artifact is in **one of
three states**, and the colour is content, not decoration:

| State | | Meaning |
| --- | --- | --- |
| 🟢 **VERIFIED** | green | Something opened it and checked. It restores. |
| 🟡 **UNOBSERVED** | amber | It was written; nothing has looked inside. It may be perfect, or empty. **This is the default.** |
| 🔴 **FAILED** | red | It was checked and it is not good. |

There is no "OK". The dashboard leads with the number of **unobserved** backups — the open
questions — not the number of jobs that succeeded. That inversion is the whole product.

## Features

- **Verified restore** — checksum, or a full restore into a throwaway database, per policy.
- **Agentless** — nothing is installed on your database host. Dumps run in ephemeral containers
  built from the target's own major version.
- **Encrypted at rest** — every artifact is encrypted with [`age`](https://age-encryption.org) to
  two recipients (operational + escrow); keys are wrapped by a KEK that lives outside the host.
- **S3-compatible destinations** — AWS S3, Cloudflare R2, Backblaze B2, MinIO, SeaweedFS, Ceph RGW.
- **Scheduling with GFS retention** — grandfather-father-son, aware of full/incremental chains.
- **Deliberate restore friction** — role-gated, scoped by an engine capability matrix, and an
  overwrite requires typing the database name.
- **Web UI** — a dashboard built around the three states, in English and Portuguese.
- **Docker-first** — a single image with no database clients, signed multi-arch releases with an
  attached SBOM.

## Quick start

You need Docker with the Compose plugin. Nothing is installed on your database servers.

```sh
git clone https://github.com/schrodump/schrodump.git
cd schrodump
cp .env.example .env

# Generate the key-encryption key and a database password, then put them in .env.
# WARNING: lose the KEK and you lose every backup — store a copy off this host.
openssl rand -base64 32   # -> SCHRODUMP_KEK
openssl rand -base64 24   # -> DB_PASSWORD

docker compose up -d
```

On first boot Schrodump prints a **one-time setup link** to create the first administrator:

```sh
docker compose logs schrodump | grep setupUrl
```

Open it, create the admin, and follow the guided flow: destination → canary → target → test →
policy. Full walkthrough in [docs/install.md](docs/install.md).

## Supported

| Databases | Object storage |
| --- | --- |
| PostgreSQL 13–18 | Any **S3-compatible** endpoint: |
| MySQL 8 | AWS S3 · Cloudflare R2 · Backblaze B2 |
| MariaDB | MinIO · SeaweedFS · Ceph RGW |
| MongoDB | |

## How it works

Schrodump is a monorepo (Node 22, TypeScript, pnpm) split by responsibility:

- **`packages/core`** — the domain: states, retention, the manifest. Pure functions, no I/O.
- **`packages/engines`** — what to run per engine (dump/restore descriptors) and connection probes.
- **`packages/runner`** — where to run it: ephemeral Docker executors and scratch management.
- **`packages/storage`** — the S3-compatible driver and its put/get/delete canary.
- **`apps/server`** — Fastify + Prisma; composes the four packages above.
- **`apps/web`** — the Next.js dashboard.

The server image contains **no** `pg_dump`, `mysqldump` or `mongodump` — running a dump in-process
would pin every target to whatever client version shipped, and widen the attack surface of the one
process that holds every database credential. Dumps run in separate, pinned, ephemeral executors.

## Security

Schrodump holds credentials for every database you point it at, which makes it a high-value target.
The [security model](docs/security.md) is explicit about it:

- Credentials are **write-only** and envelope-encrypted; the KEK belongs in a secrets manager,
  outside the host it protects.
- Artifacts are encrypted to two recipients, so one lost key is not one lost backup.
- The Docker socket is **never** mounted directly — the default stack filters it through a
  socket proxy, because socket access is root on the host.
- **Sealed mode** offers real custody separation: the instance can write artifacts it cannot read.
- Published images are **signed** (cosign, keyless) and carry an **SBOM**.

Found a vulnerability? See [SECURITY.md](SECURITY.md). Please don't open a public issue.

## Documentation

| Guide | |
| --- | --- |
| [Install & first backup](docs/install.md) | From an empty host to a verified backup. |
| [Security model](docs/security.md) | Threat model, the Docker socket, scratch, the KEK, sealed mode. |
| [Backups & restore](docs/backup-restore.md) | What a logical backup is, what it doesn't cover, why verify exists. |
| [LGPD / GDPR](docs/lgpd.md) | Retention, per-artifact encryption, Object Lock vs. the right to erasure. |
| [Roadmap & v1 scope](docs/roadmap.md) | What is deliberately outside v1, and why. |

## Project status

Schrodump is in active development toward its **v1**. The verification model, scheduling, storage,
encryption, the web UI, and the full CI + signed-release pipeline are implemented and tested. Some
execution paths — restore execution, notification delivery — and physical/PITR backups are on the
roadmap. [docs/roadmap.md](docs/roadmap.md) states exactly what is and isn't in v1.

## Contributing

Contributions are welcome under the project's Contributor License Agreement — see
[CONTRIBUTING.md](CONTRIBUTING.md). Commits follow [Conventional Commits](https://www.conventionalcommits.org/),
and `pnpm typecheck`, `pnpm lint` and `pnpm test` must be green.

## License

[AGPL-3.0-or-later](LICENSE) © ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA.

Running Schrodump as a network service means its users are entitled to its source, including your
modifications. That is a deliberate choice: a backup tool should be auditable by the people trusting
it with their data.

## Translations

**`README.md` (English) is the source of truth.** [README.pt-BR.md](README.pt-BR.md) and
[README.es.md](README.es.md) are translations kept in step with it: any change to `README.md` must
update all three in the same pull request, and CI enforces it. Fixing only a translation is fine.
