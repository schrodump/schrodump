# Restore execution — design

- **Date:** 2026-07-24
- **Status:** approved, ready for implementation plan
- **Scope:** end-to-end. Route enqueues a RESTORE job → the worker dispatches it → a real
  download → decrypt → restore-into-target pipeline runs, audited. Sub-scope selection, in-memory
  identity supply for sealed artifacts, and FULL_RESTORE-verify are explicit follow-ups.

## Problem

`POST /artifacts/:id/restore` returns `501`. The pure orchestration (`runRestoreJob`) and the port
skeleton (`createRestorePorts`) exist and are unit-tested, and the crypto layer already builds the
age decrypt descriptor (`buildAgeDecryptDescriptor`, identity mounted as a file, never on argv) and
resolves the decryption key from the manifest (`resolveDecryptionKeyId`). But nothing enqueues a
RESTORE job, the worker treats `RESTORE` as an unsupported kind, and the `runRestore` port — the
actual download → decrypt → restore-into-target execution — is unimplemented. So the restore dialog
shows a permanent "not available on the server yet" note and its submit hits a `501`. This
iteration makes restore run, end-to-end and audited. It is the **first artifact decryption path**
and the first write into a live target, so it is security-critical.

## Goals

- An operator triggers a restore from the artifact dialog; the artifact is restored back into its
  **origin target** (the database it was backed up from), audited.
- The lifecycle: `POST /artifacts/:id/restore` → RESTORE job `PENDING` → worker claims it →
  `runRestoreJob` validates the target against the engine's capability matrix, resolves the
  server-held operational decryption key, enforces the overwrite confirmation, writes an audit
  record, then runs the real pipeline → job `SUCCEEDED`/`FAILED`.
- The real `runRestore`: download the encrypted artifact from S3 → `age --decrypt` in an ephemeral
  executor with the KEK-decrypted operational identity mounted → gunzip → the engine's restore
  descriptor → the origin target, on the isolated executor network.
- A sealed artifact (no server-held operational identity for its keyIds) fails with a clear reason,
  not a crash.

## Non-goals (this iteration)

- **Sub-scope selection.** v1 restores the artifact's full contents to the origin target; the
  `target` field is validated against the capability matrix but a narrower restore (a specific
  database/schema/table by name) is a follow-up — the web does not even send the name today.
- **In-memory identity for sealed artifacts.** Sealed → fail with reason; supplying an escrow
  identity at restore time is a follow-up.
- **FULL_RESTORE verify.** The verify path restores into an *ephemeral* container (not the origin
  target) and is distinct; the `FULL_RESTORE → CHECKSUM` downgrade recorded during the worker work
  stays until a separate iteration wires it.

## Existing building blocks (reused, not rebuilt)

| Piece | Location | Role |
| --- | --- | --- |
| `runRestoreJob(req, ports)` | `jobs/restore.ts:48` | Pure: matrix check → key resolve → confirm → audit → runRestore. Sole authority over the RESTORE job's terminal state. |
| `createRestorePorts(deps)` | `jobs/restore-wiring.ts:32` | Maps deps to `RestorePorts`; `runRestore` is caller-composed. |
| `buildAgeDecryptDescriptor()` | `crypto/artifact.ts:80` | age `--decrypt`, identity mounted at `/etc/schrodump/age-identity`. |
| `resolveDecryptionKeyId(...)` | `crypto/artifact.ts:94` | Operational key whose keyId is in the manifest, else null (sealed). |
| `decryptCredential` / `parseEncryptedCredential` | `crypto/envelope.ts` | KEK-envelope decrypt — reused for the operational identity and the target credential. |
| Engine `buildRestore(RestoreInput)` | `packages/engines` (`descriptor.ts:72`) | The restore descriptor per engine. |
| `Runner` / `ScratchManager` / storage driver | `packages/runner`, `packages/storage` | Execution + download, already used by the backup path. |
| `driverForDestination(...)` | `jobs/destination-driver.ts` | Builds the S3 driver for the artifact's destination. |
| Worker dispatch + claim | `jobs/worker.ts`, `jobs/worker-wiring.ts` | The RESTORE branch plugs into the existing loop. |

The gap is the **route enqueue**, the **RESTORE job params**, the **worker RESTORE branch**, the
real **`runRestore` pipeline** (inverse of the backup pipeline), and the **audit / existing-data**
port implementations.

## Design

### 1. Data model (one migration)

Add `restoreParams Json?` to `BackupJob`. For a RESTORE job it holds
`{ target: RestoreTarget, confirmExistingDatabase: boolean, triggeredByUserId: string }`. BACKUP /
VERIFY leave it null. `artifactId` (added for the worker) carries the source artifact.

### 2. Route — enqueue instead of 501

`POST /artifacts/:id/restore` (operator+): parse the body with Zod
(`{ target: RestoreTarget, confirmExistingDatabase: boolean }`), enqueue a RESTORE `BackupJob`
(`artifactId`, `restoreParams` with the session user's id), return `202 { jobId }`. Drop the `501`.

### 3. Worker dispatch

Add the `RESTORE` branch to the worker: load the job's `restoreParams`, build the `RestoreRequest`
(`jobId`, `artifactId`, `organizationId`, `userId`, `target`, `confirmExistingDatabase`), assemble
`createRestorePorts(...)` with the real `runRestore`, and call `runRestoreJob`. `runRestoreJob`
sets the job's terminal state; a thrown error is caught by the worker and marks the job `FAILED`
with a sanitized reason (the existing catch-all).

### 4. The real `runRestore` (the crux)

1. Load the artifact, its manifest keyIds, its destination, and its **origin target**
   (`artifact → job → policy → target`); decrypt the target credential (KEK) to connect.
2. `resolveDecryptionKeyId(manifest.keyIds, availableKeys)` → the operational keyId. Load that
   `EncryptionKey.encryptedIdentity` and KEK-decrypt it (`decryptCredential`) to the age identity.
   (This resolution/validation already happens inside `runRestoreJob`; `runRestore(keyId)` receives
   the chosen keyId and materializes its identity.)
3. Build the S3 driver (`driverForDestination`); download `artifact.bin` (+ `globals.bin` for
   PostgreSQL) from the artifact's bucket key.
4. Pipeline (inverse of backup, fixed order): S3 stream → `age --decrypt` executor (identity
   written to a `0600` scratch file, mounted read-only at `/etc/schrodump/age-identity`, never on
   argv) → gunzip → the engine's `buildRestore` descriptor executor, connected to the origin target
   on the isolated executor network. Globals restored before the per-database dump for PostgreSQL.
5. Return whether every executor exited 0 (`exitCode === 0`, never inferred from EOF).

The decrypted identity and the decrypted target credential never reach a log, the response, or
`BackupJob.reason`; the scratch identity file is deleted in `finally`.

### 5. Audit and existing-data ports

- `audit(event)` writes an `AuditLog` row (`action: "restore.execute"`, `artifactId`, `userId`,
  `destinationName`, `keyId`) — restore is always audited.
- `targetHasExistingData()` probes the origin target and reports whether it already holds data,
  feeding the overwrite-confirmation gate in `runRestoreJob`.

### 6. Web

The dialog already submits `{ artifactId, target, confirmExistingDatabase }`. The mutation stops
treating `501` as expected; on `202` it reports the restore as enqueued. Remove the permanent
`restore.serverPending` note and show the enqueued/pending state instead. The `viewer`-hidden
button and the server's operator+ enforcement are unchanged.

## State machine

RESTORE job: `PENDING` → (claim) → `RUNNING` → `SUCCEEDED` | `FAILED`. A restore never changes an
`Artifact`'s state — an artifact's state is only ever set by backup (born UNOBSERVED) and verify.
Restore reads the artifact and writes the target database; it does not touch artifact rows.

## Testing

- **Unit (no Docker/S3):** the route enqueue (fake service asserts the RESTORE job + params); the
  worker RESTORE dispatch (fake executor); the `runRestore`-composition pure helpers where they
  can be extracted (e.g. the identity-file lifecycle decision, the globals-first ordering).
  `runRestoreJob` itself is already covered.
- **Runtime assembly:** the real `runRestore` (download + decrypt + restore container) is verified
  by the gated integration path and the dev smoke, like the backup pipeline.
- **Dev end-to-end smoke:** restore the smoke artifact into a **fresh** database on the seed target
  and assert the rows are present; then confirm restore-over-existing is blocked without the
  confirmation and proceeds with it.

## Risks / open questions

- **Security surface:** this is the first place an artifact is decrypted and the first write into a
  live target. The identity file must be `0600`, mounted read-only, deleted in `finally`, and never
  logged; the decrypted target credential stays inside the connection. Review must trace every hop.
- The `age`/engine restore executor images must be present in dev (built from `docker/executors/`).
- Restore-over-existing is destructive by definition; the confirmation gate + audit are the guard.
- If a dev smoke piece proves impractical, fall back to unit + gated integration and record what
  blocked — do not claim the smoke passed if it did not.

## Follow-ups (out of scope)

1. Sub-scope restore (a named database/schema/table) — needs the web to send the name.
2. In-memory identity supply for sealed artifacts.
3. FULL_RESTORE verify (restore into an ephemeral container), removing the CHECKSUM downgrade.
4. Restore into a *different* target than the origin.
