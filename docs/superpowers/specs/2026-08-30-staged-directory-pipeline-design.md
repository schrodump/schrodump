# STAGED directory pipeline — design

- **Date:** 2026-08-30
- **Status:** draft, awaiting review
- **Scope:** make a directory-format dump (`pg_dump -Fd`, `mydumper`) survive the round trip —
  packaged on the way out, unpacked on the way back — so `STAGED` can be re-enabled on both sides
  at once.

## Why this exists now

`STAGED` was not merely missing a restore path. It was **producing empty artifacts under a
`SUCCEEDED` job**, and that shipped. The dump wrote a directory into scratch; `executeAndUpload`
uploaded the container's stdout, which for a directory dump is empty; the tool exited 0; the job
was marked `SUCCEEDED`; and the scratch reservation was released, deleting the only real copy.
Measured against a real 545 MB database: every `artifact.bin` was **318 bytes** — gzip and age
headers with nothing between them.

It was invisible because restore refuses `STAGED` artifacts and verify downgrades them to
`CHECKSUM` — and a `CHECKSUM` verify **passes** on those 318 bytes, since they check out against
their own manifest. An empty artifact could reach `VERIFIED`.

`STAGED` is disabled today (`resolveExecutionMode` degrades to `STREAM` with a warning). This
design is what it takes to turn it back on without recreating that hole.

## The binding constraint

**Both sides land together, or neither does.** Re-enabling the backup side alone recreates the
original defect in a new shape: artifacts that exist, contain data, and cannot be restored — stuck
at `UNOBSERVED` forever, which the thesis treats as an open question that never closes. The restore
refusal in `runRestoreJob` and the verify downgrade in `resolveVerifyPlan` lift in the same change
that teaches the pipeline to package a directory, or they do not lift.

## Approach: tar as an executor, not as a library

The pipeline already has exactly one shape for moving bytes: a container writes to **stdout**, and
the server gzips, encrypts and uploads that stream. A directory dump breaks that shape only because
nothing turns the directory back into a stream.

So turn it into one, using the mechanism that already exists. After the dump run completes, a
second run in the **same** staging directory streams a tar to stdout:

```
tar -cf - -C <stagingPath> .
```

`engines` describes WHAT to run; this is another descriptor. `runner` runs it. `backup-wiring`
uploads its stdout through the unchanged gzip -> age -> S3 chain. On restore, the inverse: the
existing decrypt-to-scratch step writes a `.tar` instead of a single dump file, and a third
descriptor untars it into a directory that `pg_restore -Fd` / `myloader` then mounts.

Two alternatives were considered and rejected:

- **A tar library in-process** (`node-tar`). Adds a dependency that walks and reads the cleartext
  dump inside the server process, widening what touches plaintext, for no gain over a container
  that already has `tar`.
- **Uploading the directory as many objects.** Turns one artifact into N, and every part of the
  system — manifest checksum, retention, restore, verify — assumes one object per artifact. The
  blast radius is the whole catalogue.

The tar-as-executor route keeps the artifact a single opaque encrypted blob, which is what the
manifest, the checksum, retention and sealed mode all already assume.

## Components

1. **`packages/engines`** — a new descriptor pair, engine-independent:
   `buildArchiveStaging(stagingPath)` -> `tar -cf - -C <path> .`, `outputKind: "stdout"`, and
   `buildExtractStaging(sourcePath, targetPath)` -> `tar -xf <source> -C <target>`. They belong to
   the registry as shared descriptors rather than to each adapter: taring a directory is not
   engine-specific, and the golden rule says a new engine is a table entry, never a new branch.
   The image is a pinned minimal one (busybox or alpine) added to `docker/executors/` with version
   AND digest, as the mydumper executor already is.

2. **`apps/server/src/jobs/backup-wiring.ts`** — `executeAndUpload` branches on mode. `STREAM` is
   untouched. `STAGED` runs the dump (no stdout consumer), then runs the archive descriptor with
   the staging directory mounted, and uploads THAT stdout through the existing path. The checksum
   and size accounting are unchanged because they still see one stream.

3. **`apps/server/src/jobs/restore-executor.ts`** — `restoreOne` already decrypts to a scratch file
   and mounts it. For a `STAGED` artifact that file is a tar: reserve a second scratch path, run the
   extract descriptor, mount the resulting directory at `RESTORE_DUMP_PATH` instead of the file.
   The cleartext lifecycle is unchanged in shape — one `finally`, now removing a directory.

4. **The gates lift together** — `runRestoreJob`'s `executionMode !== "STREAM"` refusal,
   `resolveVerifyPlan`'s downgrade of `STAGED` to `CHECKSUM`, and `resolveExecutionMode`'s
   degradation. Not before the first three land.

## What must be true before the gates lift

- A `STAGED` backup produces an artifact whose **decrypted size is within an order of magnitude of
  the database**, asserted numerically in an integration test. The defect this design exists to
  close would have been caught by exactly one assertion — that the artifact is not tiny — and its
  absence is why it shipped. `sizeCompressedBytes` on the manifest is the cheap version of that
  check and belongs in the backup path itself, not only in a test.
- A `FULL_RESTORE` verify of a `STAGED` postgres artifact passes end to end, in the integration
  suite, against a database with real rows.
- A `SIGTERM` mid-archive removes both scratch paths — the staging directory and the tar.

## Open questions

- **Sub-scope restore of a directory artifact.** `pg_restore -Fd` can restore a single table from a
  directory dump; `myloader` is coarser. Out of scope here: this design restores the whole artifact,
  and the capability matrix keeps advertising what each engine actually supports.
- **Disk cost.** `STAGED` currently reserves scratch for the dump; taring it doubles the peak
  (directory plus tar) unless the tar streams straight to the uploader without landing — which the
  design above does, since `tar -cf -` writes to stdout and never to disk. Restore is the asymmetric
  side: the tar lands, then the extracted directory lands beside it. The reservation estimate needs
  to account for both, and `ScratchManager.reserve`'s safety factor is the place to say so.

## Testing

Unit: the two descriptors, and `executeAndUpload`'s branch (a capturing runner already exists in
`backup-wiring.test.ts`). Integration, gated as the existing suites are: a `STAGED` postgres backup
whose artifact is asserted **non-trivial in size**, restored into a sandbox and verified. That last
one is the test whose absence let a 318-byte artifact pass for a 545 MB database.
