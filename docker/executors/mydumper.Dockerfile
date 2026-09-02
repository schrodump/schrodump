# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

# Executor image for the parallel MySQL/MariaDB path. mydumper is not shipped in the official
# mysql/mariadb images, and Debian's own package is still on 0.10.1 (2020), so this pulls the
# upstream release directly.
#
# Referenced by packages/engines/src/adapters/mysql.ts as schrodump/mydumper:1.
#
# Version and digest are both pinned. An executor that floats changes how a backup is produced —
# which tables get consistent snapshots, how the dump is chunked — with nobody deciding it.

FROM debian:bookworm-slim

ARG MYDUMPER_VERSION=1.0.3-1
ARG TARGETARCH
# sha256 of the upstream .deb, per architecture.
ARG MYDUMPER_SHA256_AMD64=9120840af0fe40172fb10ea5edbed4a303f54194049c880744f92eb55a877c6c
ARG MYDUMPER_SHA256_ARM64=c0839b1cfbc543c0851e82978abba57dcd2c2ce83aa2dc6a792b2fd0f13e3532

# libmariadb3 is not a dependency of the .deb, and without it every MySQL 8.x backup fails.
#
# MySQL 8.0 and 8.4 default to caching_sha2_password. mydumper links MariaDB Connector/C, which
# loads that authentication plugin from a FILE at runtime — and nothing the package pulls in ships
# one, so the plugin directory did not exist at all and every connection died with "Plugin
# caching_sha2_password could not be loaded". MariaDB targets were unaffected, which is what let it
# sit here unnoticed: it broke only the engine most people mean by "MySQL".
#
# The build asserts the file rather than trusting the package, because this is a lookup by path at
# runtime. A dependency change would break it silently, and the failure would land on an operator
# mid-backup — on the databases big enough to have asked for parallel dumps in the first place.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) sha="${MYDUMPER_SHA256_AMD64}" ;; \
      arm64) sha="${MYDUMPER_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    deb="mydumper_${MYDUMPER_VERSION}.bookworm_${TARGETARCH}.deb"; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    curl -fsSL -o "/tmp/${deb}" \
      "https://github.com/mydumper/mydumper/releases/download/v${MYDUMPER_VERSION}/${deb}"; \
    echo "${sha}  /tmp/${deb}" | sha256sum -c -; \
    apt-get install -y --no-install-recommends "/tmp/${deb}" libmariadb3; \
    apt-get purge -y --auto-remove curl; \
    rm -rf "/tmp/${deb}" /var/lib/apt/lists/*; \
    mydumper --version; \
    myloader --version; \
    ls /usr/lib/*/libmariadb3/plugin/caching_sha2_password.so >/dev/null 2>&1 \
      || { echo "caching_sha2_password.so is missing: every MySQL 8.x backup would fail to authenticate" >&2; \
           exit 1; }

# No ENTRYPOINT and no USER, both deliberate. The runner passes the whole argv as Cmd
# (packages/runner/src/docker.ts), so an entrypoint would swallow it. The user is left alone
# because the container writes into a staging directory the server owns — forcing an unprivileged
# uid here would break those writes rather than secure them. The container is ephemeral, joins a
# restricted network and mounts nothing else.
