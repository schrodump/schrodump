# Architecture decisions

Decisions already taken for v1, each with its rationale. This document records the *why*;
implementation detail lives in the code and in each package's `CLAUDE.md`.

## 1. Logical backup in v1

Logical backup only (dumps through native clients) in v1. Physical backup will be delegated to
external tools by a future agent, **not reimplemented**.
— Reimplementing physical backup duplicates mature, engine-specific tooling with no gain for what
actually differentiates this product: restore verification.

## 2. Agentless

The target database is reached over a **network connection**, with no agent installed on the
database host.
— Lowers adoption friction and operational surface; it requires no privileged access to someone
else's host, only a credential and a route.

## 3. Docker-first, with ephemeral executors

Execution is **Docker-first**: every dump and restore runs in an ephemeral executor carrying the
client of the right version. The server image ships **no** database clients.
— Isolates conflicting client versions and keeps the server image small, auditable, and free of
third-party binaries carrying CVEs of their own.

## 4. S3-compatible destinations only

The only storage destination is **S3-compatible**. Local staging is transient and **always
deleted** after use.
— A single storage contract simplifies both the code and the operation; ephemeral staging keeps
sensitive data from accumulating on local disk.

## 5. Backup state is ternary

A backup's state is ternary: `VERIFIED` / `UNOBSERVED` / `FAILED`. **There is no "OK".**
— A backup whose restore has never been observed is not trustworthy. Forcing `UNOBSERVED` instead
of "OK" refuses the false confidence that is this category's central problem.

## 6. `organizationId` from the beginning

`organizationId` is present across the **entire** data model from the start, including in a
single-tenant deployment.
— Retrofitting multi-tenancy onto a model already in production is expensive and risky; carrying
the column from day zero is cheap and avoids a destructive migration later.

## 7. Retention is the application's responsibility

Retention is applied **by the application**. Configuring bucket lifecycle rules is **forbidden**,
and documented as such.
— Only the application knows whether a backup is `VERIFIED`. A lifecycle rule could delete the one
good backup on age alone, without ever consulting its verification state.

## 8. Client-side encryption with multiple recipients

**Client-side** encryption with multiple recipients (operational + escrow); the `keyId` is written
into the manifest so that rotation is possible.
— Encrypting before anything leaves the executor keeps the destination zero-knowledge; multiple
recipients avoid a single point of key loss; and the `keyId` in the manifest makes rotation
possible without reprocessing old backups.
