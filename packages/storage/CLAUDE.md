# @schrodump/storage

S3-compatible driver. Takes precedence over the root `CLAUDE.md` inside this directory.

## Invariants

- Imports **only** `@schrodump/core`, the AWS SDK (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`)
  and `zod` (the config schema). **Never** imports `engines` or `runner`. It knows nothing about
  Docker, nothing about databases, and assembles no pipeline — composing the pipe is
  `apps/server`'s job.
- **S3-compatible destinations only** in v1. Targets: AWS S3, Cloudflare R2, Backblaze B2, MinIO,
  SeaweedFS, Ceph RGW.
- **No credential** in a log, in an error message, or in `toString()`/serialisation. The driver
  retains no credential field; use `redactConfig` to describe a destination.

## Object layout, and one reserved name (`manifest-sidecar.ts`)

```
<prefix>/<organizationId>/<jobId>/artifact.bin     # artifactKey()
<prefix>/<organizationId>/<jobId>/manifest.json    # manifestKey()
```

`scanManifests(driver, prefix)` sweeps **every** `*/manifest.json` under the prefix and parses it —
that is how the catalog rebuild reconstructs state from the bucket alone. So `manifest.json` is a
**reserved suffix in this namespace**: anything else written under the prefix with that name will
be picked up and parsed as an artifact manifest. This is why the self-backup writes its sidecar as
`self-backup.json` (`apps/server/src/jobs/self-backup-wiring.ts`) — it describes a dump that is
deliberately not part of the artifact catalog.

## Lifecycle rules on the bucket are FORBIDDEN

> Retention is resolved by the application (`@schrodump/core`), which knows the `dependsOn` chain.
> An expiration (lifecycle) rule on the bucket does **not** know that chain: it deletes the full
> and leaves the incrementals orphaned — total data loss.

Do not configure expiration on the bucket. Deletion is always explicit, commanded by the
application after `resolveRetention`.

## Canary (`canary.ts`)

Exercises **PUT → GET → DELETE** against a throwaway object under the real configured prefix, and
reports which step failed. The DELETE is there on purpose: validating only the credential (or only
PUT+GET) lets through a key that has `s3:PutObject` but not `s3:DeleteObject` — backups then run
for months and retention fails silently. It is the verify thesis applied to the destination: a
credential that can write but cannot manage produces backups you are unable to retain.

## `forcePathStyle`

An **explicit** user setting, not auto-detection. Required on MinIO, SeaweedFS and Ceph RGW; R2 and
B2 accept virtual-hosted.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
