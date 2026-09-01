# Schrodump — root instructions

Open-source tool for scheduling and verifying **logical** database backups (PostgreSQL,
MySQL/MariaDB, MongoDB). Docker-first, agentless, S3-compatible destinations. Rights holder:
**ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA** (CNPJ 34.292.395/0001-65), licensed
**AGPL-3.0-or-later**.

## The thesis (what separates this project from a cron job running `pg_dump`)

**A backup is not trustworthy until a restore has verified it.** A job that exits 0 has proven
exactly one thing: a process ran without complaining. It has not proven the file in the bucket
holds the data. Every artifact is in **one of three states**, and the colour is content:

- **`VERIFIED`** (green) — something opened it and checked. It restores.
- **`UNOBSERVED`** (amber, never grey, never green) — it was written, nobody looked. This is the
  **default**. It may be perfect or it may be empty.
- **`FAILED`** (red) — it was checked and it is no good.

There is no "OK". The dashboard leads with the number of **unobserved** artifacts — the open
questions — not the number of successes. Any UI, API or domain decision that blurs that
distinction is wrong. See `docs/backup-restore.md` for the full rationale.

## Stack

- **Runtime:** Node.js 22 (see `.nvmrc`)
- **Language:** TypeScript ESM. The root and the packages use `moduleResolution: nodenext` and
  `verbatimModuleSyntax`. `apps/web` uses `bundler` (a Next requirement).
- **Package manager:** pnpm (see `packageManager` in `package.json`)
- **Test runner:** Vitest (native ESM, no transform)
- **Lint/format:** ESLint flat config + Prettier

## Workspace map

```
packages/core       # pure domain, no I/O. Depends on zod alone.
packages/engines    # per-engine descriptors + probe (WHAT to execute)
packages/runner     # execution via Docker + scratch (WHERE to execute)
packages/storage    # S3-compatible driver
apps/server         # Fastify + Prisma. Composes the four packages above.
apps/web            # Next.js 16 + React 19. Consumes the server API.
docker/             # production Dockerfile, entrypoint.sh, prune-store.mjs, executors/
docs/               # install, security, backup-restore, lgpd, roadmap + superpowers/
scripts/            # operator tools that must work WITHOUT Schrodump (recovery rehearsal)
.github/workflows/  # ci, security, release
compose.yaml        # deployment stack (server + postgres + docker-socket-proxy)
```

Each package and app has its **own `CLAUDE.md`**, and that file **takes precedence over this one**
inside its directory. This root file governs whatever is not overridden.

## Where the rationale already lives — read before re-litigating a decision

- **`ARCHITECTURE.md`** — the eight architecture decisions taken for v1, each with its reasoning:
  logical-only backup, agentless, Docker-first with ephemeral executors, S3-compatible destinations
  only, ternary backup state, `organizationId` from the first migration, retention owned by the
  application, and client-side encryption with multiple recipients. It records the *why*; the *how*
  lives in the code and in these `CLAUDE.md` files.
- **`docs/roadmap.md`** — what was deliberately left **out of v1** and why (physical backup/PITR,
  the agent that would be written in Go, local filesystem destinations, S3 Object Lock), plus the
  **known limitations** that ship in v1. Notifications and self-backup are **not** on that list —
  both shipped, and the roadmap records how.
- **`docs/superpowers/plans/` and `docs/superpowers/specs/`** — design records for the features
  that needed one (full-restore verify, job worker, restore execution, graceful shutdown,
  notifications, the staged directory pipeline).

## Dependency graph

Follow it strictly — CI and review will enforce it:

- `packages/core` — imports no other workspace package.
- `packages/engines`, `packages/runner`, `packages/storage` — import **only** `core`, and
  **never** each other.
- `apps/*` — compose the packages above; they are the only place those packages meet.
- `apps/web` imports **no** workspace package: it re-declares the domain vocabulary in
  `src/lib/domain.ts` (see its own `CLAUDE.md`).

## How to verify (without evidence, it is not done)

From the root, across the whole workspace:

```
pnpm typecheck      # tsc --noEmit per package (+ prisma generate in the server)
pnpm lint           # eslint
pnpm test           # vitest run — unit tests; skips the integration suites by default
pnpm build          # tsc for the packages + next build for the web
```

The **integration** tests (real databases via testcontainers, real S3) only run with the
environment set — otherwise they are `describe.skipIf`:

- `SCHRODUMP_TEST_INTEGRATION=1` — enables probe (testcontainers), runner (dockerode) and the
  server suites that need a real PostgreSQL.
- `SCHRODUMP_TEST_S3_ENDPOINT` (+ `_REGION`/`_ACCESS_KEY`/`_SECRET_KEY`/`_BUCKET`) — enables the
  S3 driver against MinIO.
- `SCHRODUMP_TEST_POSTGRES_IMAGE`, `SCHRODUMP_TEST_MYSQL_IMAGE`, `SCHRODUMP_TEST_MONGO_IMAGE` —
  override the container image the probe suites stand up. This is how CI covers the edges of the
  supported range (`postgres:13-alpine`, `postgres:18-alpine`, `mariadb:11`) without running the
  whole suite again. See `.github/workflows/ci.yml`.

## Image and deployment

- `docker/Dockerfile` — a single image (Fastify API + Next UI), multi-stage, Node alpine pinned to
  the patch, non-root user, `dumb-init` as PID 1, `prisma migrate deploy` in the entrypoint.
  **No database client inside it** — dump and restore run in ephemeral executors. The size target
  and the dependency pruning (`docker/prune-store.mjs`) are documented there.
- `docker/executors/` holds **one** file: `mydumper.Dockerfile` (STAGED mysql/mariadb), with the
  version **and digest** pinned. There is **no `age` executor** — artifact encryption is
  in-process via the `age-encryption` library. See `apps/server/CLAUDE.md` for why.
- CI: `ci.yml` (dco, readme-sync, check, integration, image build/smoke), `security.yml`
  (dependency audit, Trivy, gitleaks, SPDX), `release.yml` (multi-arch image, cosign, SBOM, and the
  executor images, on a `v*` tag).
- **Contributions are certified by DCO, not a CLA.** Every commit in a pull request needs a
  `Signed-off-by` trailer (`git commit -s`); the `dco` job enforces it over `base..head` only, so
  existing history is untouched. It fails closed — an unreadable range or an empty one is a
  failure, because the first version of that check reported success when `git rev-list` failed.

## READMEs — synchronisation is mandatory

The project has three READMEs: `README.md` (English, the **source of truth**), `README.pt-BR.md`
and `README.es.md`. They are the same document in three languages.

**Rule:** any content change to `README.md` must update all three in the **same commit/PR**.
Fixing one translation alone (a typo, grammar) without touching the English is allowed. The
`readme-sync` job in `ci.yml` enforces the direction that matters: English changed → the
translations must change with it. It detects that the files were touched, not semantic
equivalence — keeping the meaning aligned is the editor's responsibility.

## SPDX header (mandatory)

Every source file begins with — including `Dockerfile`, workflows and `.mjs`:

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```

The one tracked exception is `apps/web/next-env.d.ts`, regenerated by `next build`. The `spdx` job
in `security.yml` enforces the header over `*.ts`, `*.tsx`, `*.mjs`, `*.js`, `*.sh`,
`docker/Dockerfile`, `docker/executors/*.Dockerfile` and `.github/workflows/*.yml`. In a shell
script the header goes under the shebang — the check reads the first five lines. Prisma migrations
(`.sql`) do not carry it.
