# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

# syntax=docker/dockerfile:1.7

# Single publishable image: the Fastify API and the Next UI in one container.
#
# What is deliberately NOT here: pg_dump, mysqldump, mongodump, mydumper, age. Dump and restore
# run in ephemeral executor containers built from the target's own major version (see
# docker/executors/ and packages/engines). A database client inside this image would mean the
# server dumps in-process — a different architecture, and one that pins every target to whatever
# client version we happened to ship.

# Node is pinned to a patch, not a floating major: a base image that moves on its own changes the
# runtime of a backup tool without anyone deciding it.
ARG NODE_IMAGE=node:22.23.1-alpine

# ---------------------------------------------------------------------------
# manifests — the copy set every install stage starts from
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS manifests
RUN corepack enable
WORKDIR /app

# Only manifests: editing a .ts file must not invalidate an install layer. Every workspace project
# is copied even when it will not be installed, because --frozen-lockfile compares the two.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/engines/package.json packages/engines/
COPY packages/runner/package.json packages/runner/
COPY packages/storage/package.json packages/storage/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# ---------------------------------------------------------------------------
# deps — full workspace install, used only to build
# ---------------------------------------------------------------------------
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile packages, server and web
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json eslint.config.js ./
COPY packages packages
COPY apps apps

# Baked into the Next routes manifest at build time: inside this image the API listens on
# loopback:8081 and the UI is the only thing exposed. Changing it means rebuilding.
ENV SCHRODUMP_API_URL=http://127.0.0.1:8081
ENV NEXT_TELEMETRY_DISABLED=1

# Prisma generates against this stage's platform, so the musl query engine is the one that ships.
RUN pnpm -r build

# ---------------------------------------------------------------------------
# prod-deps — the runtime dependency tree, installed from a clean store
# ---------------------------------------------------------------------------
# Deliberately built from `manifests` and not from `build`: a --prod install on top of a full
# install leaves the workspace store intact, so Next, the SWC binary and TypeScript would ride
# along. Starting clean means the store only ever holds the server's production closure.
FROM manifests AS prod-deps
WORKDIR /app

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    CI=true pnpm install --frozen-lockfile --prod --filter @schrodump/server...

# The Prisma CLI is needed at runtime for `migrate deploy`, at exactly the version the client was
# generated with — a drift between the two is a migration that silently does the wrong thing. It
# lives in its own prefix because --prod excludes it (it is a devDependency).
COPY apps/server/prisma apps/server/prisma
RUN PRISMA_VERSION="$(node -p "require('/app/apps/server/node_modules/@prisma/client/package.json').version")" && \
    npm install --no-audit --no-fund --omit=dev --prefix /deploy/prisma "prisma@${PRISMA_VERSION}" && \
    /deploy/prisma/node_modules/.bin/prisma generate --schema apps/server/prisma/schema.prisma

# Prisma ships a WASM query engine per database vendor, twice (.js and .mjs), for edge runtimes.
# Schrodump's metadata database is PostgreSQL and this is Node using the native library engine,
# so the CockroachDB/MySQL/SQL Server/SQLite copies are dead weight. Likewise the CLI carries a
# query engine for `studio` and `db execute`; `migrate deploy` uses the schema engine only.
# Both cuts are load-bearing enough that the container smoke test is what proves them safe.
RUN find /app/node_modules/.pnpm -path "*/@prisma/client/runtime/*" \
      \( -name "*cockroachdb*" -o -name "*mysql*" -o -name "*sqlserver*" -o -name "*sqlite*" \) \
      -delete && \
    find /deploy/prisma -name "libquery_engine-*.so.node" -delete

# Drops the store entries nothing in the runtime can reach — see the file for why a filtered
# install is not enough. Runs last so the Prisma client it just generated is already linked.
COPY docker/prune-store.mjs /tmp/prune-store.mjs
RUN node /tmp/prune-store.mjs && rm /tmp/prune-store.mjs && du -sh /app/node_modules

# ---------------------------------------------------------------------------
# runtime — production artefacts only
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# dumb-init reaps zombies and forwards signals; openssl is what the Prisma engines link against.
RUN apk add --no-cache dumb-init openssl && \
    addgroup -S schrodump && \
    adduser -S -G schrodump -h /app -s /sbin/nologin schrodump

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8081 \
    WEB_PORT=8080 \
    HOSTNAME=0.0.0.0

# API: dependency tree first, then the compiled output laid over it. The tree is copied whole
# because the workspace links inside it are relative — splitting it would break resolution.
COPY --from=prod-deps --chown=schrodump:schrodump /app ./server
COPY --from=prod-deps --chown=schrodump:schrodump /deploy/prisma ./prisma-cli
COPY --from=build --chown=schrodump:schrodump /app/packages/core/dist ./server/packages/core/dist
COPY --from=build --chown=schrodump:schrodump /app/packages/engines/dist ./server/packages/engines/dist
COPY --from=build --chown=schrodump:schrodump /app/packages/runner/dist ./server/packages/runner/dist
COPY --from=build --chown=schrodump:schrodump /app/packages/storage/dist ./server/packages/storage/dist
COPY --from=build --chown=schrodump:schrodump /app/apps/server/dist ./server/apps/server/dist

# UI: only the files Next traced as reachable, not the app's node_modules.
COPY --from=build --chown=schrodump:schrodump /app/apps/web/.next/standalone ./web
COPY --from=build --chown=schrodump:schrodump /app/apps/web/.next/static ./web/apps/web/.next/static

COPY --chown=schrodump:schrodump docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Scratch holds dumps in clear while a job runs; it is a volume so it never lands in a layer.
RUN mkdir -p /scratch && chown schrodump:schrodump /scratch
VOLUME ["/scratch"]

USER schrodump
EXPOSE 8080

# Probes the API, not the UI: the UI answering while the API is down is exactly the state a
# healthcheck exists to catch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
