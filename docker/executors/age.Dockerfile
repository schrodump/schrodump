# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

# Executor image for artifact encryption and decryption. The server generates key material with
# the age JS library, but every artifact byte goes through this binary — the reference
# implementation, never a reimplementation.
#
# Referenced by apps/server/src/crypto/artifact.ts as schrodump/age:1.
#
# Alpine packages age 1.2.1; upstream is 1.3.1, and a crypto executor is the last place to run a
# version behind. Version and digest are both pinned: an image that silently changes the binary
# that encrypts every backup is the definition of a supply chain problem.

FROM alpine:3.21

ARG AGE_VERSION=v1.3.1
ARG TARGETARCH
# sha256 of the upstream release tarball, per architecture.
ARG AGE_SHA256_AMD64=bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377
ARG AGE_SHA256_ARM64=c6878a324421b69e3e20b00ba17c04bc5c6dab0030cfe55bf8f68fa8d9e9093a

RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) sha="${AGE_SHA256_AMD64}" ;; \
      arm64) sha="${AGE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    tarball="age-${AGE_VERSION}-linux-${TARGETARCH}.tar.gz"; \
    apk add --no-cache --virtual .fetch ca-certificates curl; \
    curl -fsSL -o "/tmp/${tarball}" \
      "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/${tarball}"; \
    echo "${sha}  /tmp/${tarball}" | sha256sum -c -; \
    tar -xzf "/tmp/${tarball}" -C /tmp; \
    install -m 0755 /tmp/age/age /usr/local/bin/age; \
    install -m 0755 /tmp/age/age-keygen /usr/local/bin/age-keygen; \
    apk del .fetch; \
    rm -rf "/tmp/${tarball}" /tmp/age; \
    age --version

# No ENTRYPOINT and no USER — same reasoning as the mydumper executor: the runner supplies the
# full argv as Cmd, and decryption reads an identity file mounted by the server.
