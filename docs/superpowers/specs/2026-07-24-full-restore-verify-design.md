# FULL_RESTORE verify — design

- **Date:** 2026-07-24
- **Status:** approved, ready for implementation plan
- **Scope:** turn `FULL_RESTORE` verify from a stub (currently downgraded to `CHECKSUM`) into a real
  proof — restore the artifact into an ephemeral, isolated PostgreSQL container, assert the schema is
  present, then destroy it. PostgreSQL only in v1 (it reuses the postgres-only restore pipeline).

## The thesis this delivers

The product leads by the count of **unobserved** backups — questions no one has answered. `CHECKSUM`
verify proves the stored bytes decrypt and hash correctly; it does **not** prove they *restore*.
`FULL_RESTORE` is the only level that turns a backup from a question into an answer by actually
restoring it. This design implements it for PostgreSQL, reusing the restore pipeline shipped in
`feat/restore-execution`.

## What already exists (do not rebuild)

- **Domain** (`apps/server/src/jobs/verify.ts`): `runVerifyJob` already branches to a `fullRestore()`
  port, already downgrades `FULL_RESTORE → CHECKSUM` when the destination is sealed, and already
  makes verify the *sole* authority over an artifact's final state (`VERIFIED` / `FAILED`), leaving
  it `UNOBSERVED` when verify is off. This design **refines** the port's contract (three-way result)
  and its wiring — it does not rewrite the domain.
- **Engine assertions** (`packages/engines`): `postgresAdapter.buildVerifyAssertions(input)` already
  emits `psql … -c "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN
  ('pg_catalog','information_schema')"` with `ON_ERROR_STOP=1`. Reused as-is.
- **Restore pipeline** (`apps/server/src/jobs/restore-executor.ts`): `runRestorePipeline` — download
  → in-process age-decrypt → gunzip → mounted file → `pg_restore`/globals `psql`, into a target
  connection. Reused as-is, pointed at the ephemeral sandbox instead of the origin target.
- **Runner** (`packages/runner`): `DockerRunner.run` runs **one-shot** executors (start → wait for
  exit → remove). The sandbox is a **service** (start → become ready → others connect → destroy), a
  capability the runner does not have yet.

## Scope

- **PostgreSQL only.** `FULL_RESTORE` reuses the restore pipeline, which is postgres-only in v1. A
  `FULL_RESTORE` policy on a MySQL/MariaDB/MongoDB target **downgrades to `CHECKSUM`** (visible),
  joining the existing **sealed** downgrade (no server-held identity → `FULL_RESTORE` impossible).
- **Out of scope (follow-ups):** count-based assertions (comparing restored table/row counts against
  values recorded at backup time — needs a backup + manifest change); `FULL_RESTORE` for other
  engines (follows their restore); making `CHECKSUM` infra-failure-aware the same way (see §4).

## Architecture

The change areas: a new runner capability (§1), an engine sandbox descriptor (§2), the `runFullRestore`
wiring (§3), the domain's three-way result (§4), lifting the stale `resolveVerifyPlan` downgrade (§5),
and a typed-error refinement in `restore-executor` (folded into §3, so verify can tell an artifact
fault from an infra fault). The data flow of one `FULL_RESTORE` verify:

```
reserve scratch → KEK-decrypt identity → runner.withEphemeralService(sandbox):
    start postgres:<major>-alpine on the isolated network
    poll readiness (docker exec … pg_isready) until ready or timeout
    ├─ runRestorePipeline(→ sandbox connection)   # globals first, then the artifact
    └─ run buildVerifyAssertions(→ sandbox)        # exit 0 AND table count ≥ 1
    destroy the container (finally)
→ map to VERIFIED / FAILED / INCONCLUSIVE
```

### 1. Runner — `withEphemeralService` (`packages/runner`)

A new method on the `Runner` interface, distinct from `run`:

```ts
export interface EphemeralServiceSpec {
  readonly image: string;
  readonly env: Record<string, string>;
  readonly network: string;
  // Command run via `docker exec` to poll readiness; exit 0 means ready. e.g. ["pg_isready","-U","verify"].
  readonly readinessCommand: string[];
  // The port the service listens on inside the container (5432 for postgres).
  readonly port: number;
  readonly correlationId: string;
  // Bounds BOTH readiness polling and the whole service lifetime.
  readonly readinessTimeoutMs: number;
}

export interface EphemeralServiceHandle {
  // The container's address ON THE ISOLATED NETWORK — reachable by executors joined to that network,
  // never host-published. `host` is the container's network alias/IP; `port` echoes the spec.
  readonly host: string;
  readonly port: number;
}

// Starts the service, polls readiness, invokes `use` with the in-network address, and force-removes
// the container in `finally` (success OR throw). Never `wait()`s the container for exit. If readiness
// never succeeds within readinessTimeoutMs, throws SchrodumpError code "RUNNER_SERVICE_NOT_READY"
// (no `use` call). Returns whatever `use` returns.
withEphemeralService<T>(spec: EphemeralServiceSpec, use: (h: EphemeralServiceHandle) => Promise<T>): Promise<T>;
```

- **DockerEngine gains `startService(spec)`** returning a `StartedService { host; exec(cmd): Promise<number>; remove(): Promise<void> }`. The real `DockerodeEngine` implements it (createContainer + start + `container.inspect` for the network IP/alias + `container.exec` for readiness + `remove({force:true})`); a fake in tests drives the lifecycle (ready-after-N-polls, throws) with no daemon. This mirrors how `run`'s exit-code/timeout/cleanup logic is unit-tested today.
- **Readiness:** poll `startService.exec(readinessCommand)` every ~500 ms; exit 0 → ready. Bounded by `readinessTimeoutMs`. This is why the sandbox image must carry the readiness binary (`postgres:*-alpine` ships `pg_isready`).
- **Isolation:** the service joins `spec.network` (the isolated executor network). Executors run by `run` on the same network reach it by `host`.
- **Teardown:** `remove({force:true})` in `finally`. A service that never became ready is also removed. Aligned with the existing "manual removal, never AutoRemove" rule.
- **Boundary:** the runner keeps sole ownership of Docker. `apps/server` never touches dockerode; it composes `withEphemeralService`.

### 2. Engines — `buildVerifySandbox` (`packages/engines`)

The sandbox needs a postgres of the artifact's major, bootstrapped with credentials the restore/assert
executors will use. The **host** is only known at runtime (from the runner), so the adapter supplies
everything *except* the host:

```ts
export interface VerifySandbox {
  readonly image: string;                    // postgres:<major>-alpine (imageFor)
  readonly env: Record<string, string>;      // POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
  readonly readinessCommand: string[];       // ["pg_isready","-U",<user>,"-d",<db>]
  readonly port: number;                     // 5432
  // The connection an executor uses to reach the sandbox, minus host (filled at runtime).
  readonly username: string;
  readonly password: string;                 // caller-supplied random secret
  readonly database: string;
}

// buildVerifySandbox(serverVersionNum, password) on postgresAdapter (optional on the interface;
// only engines with an in-process restore implement it — mirrors buildGlobalsRestore being optional).
```

- Fixed sandbox identifiers: `username: "verify"`, `database: "verify"`. The `password` is generated
  per verify by the caller (`randomUUID`) and passed in — never a constant, even for a throwaway.
- The restore targets `{ host: <runtime>, port: 5432, username: "verify", password, database: "verify",
  tls: false }`. TLS is off: it is a localhost-equivalent link on an isolated Docker network to a
  container that lives seconds; requiring TLS would mean provisioning certs for a throwaway.
- A `-Fc` custom-format dump carries object definitions, not the database name, so restoring a dump
  taken from any origin database into the `verify` database is correct. Globals restore first
  (best-effort, no `ON_ERROR_STOP`) so referenced roles exist; the sandbox's own bootstrap role
  conflicting is the expected, ignored case the globals path already tolerates.

### 3. verify-wiring — `runFullRestore` (`apps/server`)

Composes the above into the `fullRestore` port. Sketch:

```
runFullRestore(): Promise<VerifyProof> {
  if engine !== "postgres": return "INCONCLUSIVE"        // guarded upstream too; defensive
  password = randomUUID()
  sandbox = adapter.buildVerifySandbox(artifact.serverVersionNum, password)
  try {
    return await runner.withEphemeralService(
      { image: sandbox.image, env: sandbox.env, network, readinessCommand: sandbox.readinessCommand,
        port: sandbox.port, readinessTimeoutMs, correlationId: job.id },
      async ({ host }) => {
        conn = { host, port: sandbox.port, username: sandbox.username, password, database: sandbox.database, tls: false }
        await runRestorePipeline({ …, buildRestoreDescriptor: sp => adapter.buildRestore({connection: conn, …, sourcePath: sp}),
                                   buildGlobalsRestoreDescriptor: …, ageIdentity, driver, reserveStaging, network, … })
        // runRestorePipeline resolves true or THROWS a typed SchrodumpError (classified in the catch).
        assert = await runner.run(adapter.buildVerifyAssertions({connection: conn, …}), { network, mounts: [], stdout, … })
        // exit 0 AND the printed count ≥ 1 → schema present
        return assert.exitCode === 0 && parseCount(stdout) >= 1 ? "VERIFIED" : "FAILED"
      })
  } catch (err) {
    return classifyVerifyError(err)   // typed code → FAILED (artifact bad) vs INCONCLUSIVE (our infra)
  }
}
```

- The identity is KEK-decrypted in memory (as restore does) and handed to `runRestorePipeline`; it
  never touches disk.
- Scratch is mandatory (the decrypted cleartext dump stages there, exactly as restore requires).
- Secret hygiene is inherited from `runRestorePipeline` (identity/credential never logged, returned,
  or written to `BackupJob.reason`). The sandbox password is a throwaway on an isolated network.
- **Distinguishing FAILED vs INCONCLUSIVE by typed error.** `runRestorePipeline` resolves `true` or
  **throws** — it never returns `false` — and it throws for *both* "the artifact is bad" (a non-zero
  engine exit, a truncated/corrupt stream) and "our infra broke" (S3 unreachable). A `catch` alone
  cannot tell them apart, so a genuinely bad artifact would be mislabeled `INCONCLUSIVE` and never
  reach `FAILED`. Fix: **restore-executor's throws become typed `SchrodumpError`s with a `code`**
  (a small, backward-compatible change also improving the real restore path — the messages stay
  credential-free, and `runRestoreJob` still reads `error.message`):
  - `RESTORE_SOURCE_FAILED` (S3 get failed) → **INCONCLUSIVE** — we could not fetch the bytes.
  - `RESTORE_DECRYPT_FAILED` (decrypt/gunzip failed on the stored bytes) → **FAILED** — the stored
    artifact does not decrypt/decompress; that unusability is exactly what verify must catch.
  - `RESTORE_EXECUTOR_FAILED` (an engine executor exited non-zero — into a *fresh* sandbox, that is
    the archive's fault) → **FAILED**.
  - `RUNNER_SERVICE_NOT_READY` / any other runner/docker error → **INCONCLUSIVE** — our infra.
  - A failing assertion (exit ≠ 0 or count < 1) → **FAILED** — restored, but no usable schema.

  `classifyVerifyError(err)` maps `SchrodumpError.code` to `VerifyProof`; an unrecognized/untyped
  throw defaults to **INCONCLUSIVE** (never mark a backup bad on a surprise). This makes the wiring's
  catch total — see §4.

### 4. Domain — three-way verify result (`apps/server/src/jobs/verify.ts`)

The `fullRestore` port changes from `Promise<boolean>` to `Promise<VerifyProof>` where
`VerifyProof = "VERIFIED" | "FAILED" | "INCONCLUSIVE"`. `runVerifyJob` maps it:

| `fullRestore()` result | Artifact state | Job state | Meaning |
| --- | --- | --- | --- |
| `VERIFIED` | `VERIFIED` | `SUCCEEDED` | restored clean, schema present |
| `FAILED` | `FAILED` | `FAILED` | restored/asserted and it is bad |
| `INCONCLUSIVE` | **unchanged** (stays `UNOBSERVED`) | `FAILED` (retryable) | we could not run the test |

- `INCONCLUSIVE` is the thesis-critical case: an infra failure must **never** mark a possibly-good
  backup `FAILED`. The artifact stays the open question it was; the job is visibly `FAILED` so an
  operator (or a retry) tries again.
- `CHECKSUM` (`checksumMatches(): Promise<boolean>`) is unchanged in v1: `true → VERIFIED`,
  `false → FAILED`, a thrown error → the existing catch marks `FAILED`. Making CHECKSUM
  infra-failure-aware (a failed S3 download is also "could not check") is a noted follow-up, not this
  change — it would touch the checksum path and is orthogonal to `FULL_RESTORE`.
- `runVerifyJob` branches by level: `FULL_RESTORE` consumes the three-way `VerifyProof` from
  `fullRestore()`; `CHECKSUM` keeps the boolean from `checksumMatches()` (`true → VERIFIED`,
  `false → FAILED`). Because `runFullRestore`'s catch is **total** (every throw is classified, with
  an unrecognized throw defaulting to `INCONCLUSIVE`), `fullRestore()` does not throw, so
  `runVerifyJob`'s existing `try/catch → artifact FAILED` fires only on the `CHECKSUM` path (a
  `checksumMatches()` throw) — unchanged behavior there, and never a surprise `FAILED` for
  `FULL_RESTORE`.

### 5. `resolveVerifyPlan` — lift the stale downgrade (`apps/server/src/jobs/worker-wiring.ts`)

Today it downgrades **all** `FULL_RESTORE → CHECKSUM` with reason "restore executor unavailable"
(true when restore returned 501). Change: downgrade `FULL_RESTORE → CHECKSUM` only for
**non-postgres** engines (reason: "FULL_RESTORE runs for PostgreSQL only in v1"). The engine is
available where the plan is resolved (it already reads the policy/target). The **sealed** downgrade
lives in the domain (`runVerifyJob`) and is unchanged; both downgrades stay visible on the job.

## Testing

- **Unit (no Docker):**
  - `withEphemeralService` with a fake `DockerEngine`: ready-after-N-polls → `use` called with the
    address, container removed; never-ready → `RUNNER_SERVICE_NOT_READY`, container removed, `use`
    not called; `use` throws → container still removed (teardown-in-finally).
  - `runVerifyJob`: the three `VerifyProof` outcomes map to the table in §4 (INCONCLUSIVE leaves the
    artifact untouched); sealed still downgrades; NONE stays UNOBSERVED.
  - `buildVerifySandbox`: image matches the major, env carries the bootstrap creds, readiness command
    references the sandbox user/db, no secret on argv beyond the throwaway sandbox password.
  - `resolveVerifyPlan`: postgres keeps FULL_RESTORE; mysql/mariadb/mongodb downgrade with the reason.
- **Integration/smoke (real Docker + S3/MinIO + the postgres artifact), gated by
  `SCHRODUMP_TEST_INTEGRATION`:** a FULL_RESTORE verify of the seeded artifact spins up the ephemeral
  sandbox, restores 500 rows, the assertion passes → artifact `VERIFIED`, container gone; a
  deliberately corrupt/empty artifact → `FAILED`; a sandbox that cannot start (bad image tag) →
  `INCONCLUSIVE`, artifact stays `UNOBSERVED`.

## Follow-ups (out of scope)

1. Count-based assertion (record expected table/row counts at backup, compare on verify).
2. `FULL_RESTORE` for MySQL/MariaDB/MongoDB — follows each engine's restore landing.
3. Make `CHECKSUM` infra-failure-aware (a failed download → `INCONCLUSIVE`, not `FAILED`).
4. A verify-sandbox resource budget (the ephemeral DB + restore can be large); today it shares the
   scratch budget and the readiness timeout, with no separate sizing pass.
