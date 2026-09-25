# Security model

Schrodump holds credentials for every database you point it at and can start containers on the
host that runs it. That combination is the whole threat model: it is a single box whose
compromise is not one service but your entire database estate, plus the backups that would have
been the way back.

This document states what is protected, what is not, and which parts are your responsibility
rather than the software's.

## What an attacker gets from each piece

| If they get…                | They get…                                          |
| --------------------------- | -------------------------------------------------- |
| The Docker socket           | Root on the host. Everything below stops mattering |
| The metadata database + KEK | Every stored database credential                   |
| The metadata database alone | Credential ciphertext, useless without the KEK     |
| The bucket + artefact keys  | Your data                                          |
| The bucket alone            | Encrypted artefacts and their sizes and timing     |
| The scratch volume mid-job  | One database dump, in clear                        |
| A sandbox volume mid-verify | The restored database, in clear                    |

## The Docker socket is the most critical asset

Schrodump starts containers to run dumps. That requires access to the Docker API, and
**unrestricted access to the Docker socket is equivalent to root on the host** — anyone who can
create a container can mount `/` into it.

This is why the default `compose.yaml` does not mount the socket into Schrodump. It mounts it
read-only into `tecnativa/docker-socket-proxy`, which exposes only the endpoints Schrodump needs:

```yaml
CONTAINERS: 1 # create, inspect and remove executors
IMAGES: 1 # pull executor images
NETWORKS: 1 # attach executors to the target network
INFO: 1
POST: 1
EXEC: 1 # readiness-probe a verify sandbox; see below
VOLUMES: 0 # no named-volume management
```

**Be precise about what this buys, because the previous version of this section was not.** The
proxy removes endpoints Schrodump never calls — swarm, system prune, image deletion, and the rest —
so a bug or a stray call cannot reach them. That is a real reduction in accidental surface.

It is **not** a containment boundary against a compromised Schrodump. `CONTAINERS` plus `POST` is
the permission to create a container, and a container create carries `Binds` and `Privileged`.
Verified against `tecnativa/docker-socket-proxy:v0.4.2`: a create with a host bind mount is
accepted (`201`), and so is one with `Privileged: true`. `VOLUMES: 0` governs named-volume
management and does not prevent either — the earlier claim that it stopped host mounts was wrong.

So the honest statement is: anything that can reach this proxy can obtain root on the host,
because that is what running dumps in containers requires. The boundary you actually have is the
host itself. Run Schrodump where you would be willing to treat the Docker daemon as compromised if
Schrodump were.

`EXEC: 1` is required rather than optional, and it was `0` until this was measured. `FULL_RESTORE`
verify stands up a throwaway database and polls its readiness with `docker exec`; with `EXEC: 0`
the proxy answers `403` to `POST /exec/<id>/start`, the probe never succeeds, and the verification
this whole product is built around cannot run. CI did not catch it because the integration suite
talks to the Docker socket directly rather than through the proxy. Given the paragraph above, the
flag costs nothing an attacker did not already have.

`EXEC: 0` and `VOLUMES: 0` are the two that matter. With `EXEC` a compromised Schrodump could run
commands inside any container on the host; with `VOLUMES` it could create a container that mounts
the host root. Neither is needed to take a backup.

The proxy image is pinned to an exact version, for the same reason: the component enforcing this
boundary must not change without someone deciding that it should.

**If you replace this arrangement**, understand what you are accepting. Mounting
`/var/run/docker.sock` directly into Schrodump means a remote-code-execution bug in Schrodump is
a host takeover, not a service compromise.

### The proxy carries the job, so it must not time the job

The image ships an HAProxy config with `timeout client 10m` and `timeout server 10m`, and neither
is configurable through the container's environment (upstream issue #148). Ten minutes is fatal to
a real backup. A dump reaches Schrodump over a single attach stream and its exit code over a
`container.wait()` long-poll — and both go **silent** for the length of the job: a `pg_dump`/
`mongodump` that streams steadily still sends nothing on the wait channel until it exits, and a
`pg_restore` verify writes to the database, not to stdout, for its entire run. So on any job longer
than ten minutes the proxy severed the idle connection (an `sD` server-timeout in the proxy log, at
exactly 600s), the runner blocked on a `wait()` that never settled, and the job hung until the 3h
`DUMP_TIMEOUT_MS` ceiling with its executor container left orphaned. A 655 MB verify hung this way
on the first production deployment.

`compose.yaml` disables both idle timeouts on the proxy — patched into the in-image template by the
`docker-proxy` entrypoint, before the stock entrypoint reads it, so no host file has to be mounted.
This does not weaken the boundary: the timeout is a generic anti-slowloris default for an
internet-facing balancer, and this proxy sees exactly one client (Schrodump) on an internal
network. The **real** ceiling is owned where it belongs — in the runner, whose `DUMP_TIMEOUT_MS`
kills the executor on expiry, which ends the attach and settles the wait. `socket-proxy.integration.test.ts`
reproduces the cut against a short timeout and proves that disabling it is what lets a long job's
wait return.

## What the server will and will not connect to

Four fields in the API name an address that Schrodump then dials: a notification channel's
**webhook URL**, a destination's **S3 endpoint**, an SMTP channel's **host and port**, and a
database target's **host and port**. Each of them reports back whether something answered — the
webhook's HTTP status through the channel's last failure, the canary's failed operation, the
probe's failure code. That combination is a port scanner with a credential form in front of it,
and the interesting side of the scan is not the internet: the server sits on the `internal`
network beside the metadata database (`db:5432`) and the Docker socket proxy
(`docker-proxy:2375`). An `operator` — a role that is deliberately not given access to the host or
to the metadata database — could otherwise point a channel at the socket proxy, press **Send a
test**, and read the reflected status. The webhook path is a `POST`, and the proxy's permissions
accept Docker's body-less prune endpoints, so the same button is also a way to delete containers
and images.

One guard, in the server, checks all four. It resolves the host name first and judges the
**resolved address**, so a name an attacker controls pointed at `127.0.0.1` is refused the same
way the literal is.

**Refused with nothing configured:**

| Refused                                        | Why it can never be a legitimate destination           |
| ---------------------------------------------- | ------------------------------------------------------ |
| `127.0.0.0/8`, `::1`                            | Loopback: it can only be this container itself         |
| `169.254.0.0/16`, `fe80::/10`                   | Link-local. `169.254.169.254` is the cloud instance metadata service, which hands out credentials |
| `0.0.0.0/8`, `::`                               | Not a routable destination                             |
| `db`, `docker-proxy`, `schrodump`, `scratch-init` | The compose stack's own services, by name — any port |
| Whatever `DATABASE_URL`, `DOCKER_HOST` and `SCHRODUMP_URL` name | The same three pieces of the control plane, read off your own configuration |
| The addresses those names currently resolve to, and every address this process is bound to | So that a name-based block is not walked around with the container's bridge address, and so that "the API's own port" holds however it is reached |

**Not refused, and that is the decision.** Private ranges — `10/8`, `172.16/12`, `192.168/16`,
`fc00::/7` — are allowed. Schrodump is self-hosted: a PostgreSQL on `10.0.0.5` and a MinIO on
`192.168.1.10` are the normal case for this product, not the attack. A default that blocked them
would break more real deployments than it protected, and would be switched off by the first
operator it inconvenienced. **The guard's job here is to stop a pivot onto the deployment's own
control plane, not to firewall your LAN.**

Two variables move the line, both comma-separated lists of CIDRs (a bare address means that one
host). An unparseable entry stops the boot naming the variable, rather than becoming a rule that
silently does not apply.

- **`SCHRODUMP_EGRESS_DENY`** adds to the refusals. If every database you back up is public, or is
  reached only by the executors on their own network, shut the private ranges:
  `SCHRODUMP_EGRESS_DENY=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7`.
- **`SCHRODUMP_EGRESS_ALLOW`** overrides every refusal, the built-in ones included. It exists for
  the case the self-service rule gets wrong on purpose: a deployment whose metadata PostgreSQL also
  holds a database somebody backs up.

A refusal is a `400` from the route that took the address, naming the field and saying why, and a
recorded job or channel failure where it is only discovered later — a target row written before
this existed, or one the deny list was tightened under.

Two limits worth stating plainly:

- **Webhook redirects are followed by hand and re-checked on every hop.** A saved URL pointing at a
  host you own, whose `302` points at `docker-proxy:2375`, is the obvious way around a check made
  before the request. The chain is capped and each hop goes through the guard.
- **DNS rebinding is not covered.** A name that resolves to an allowed address for the check and to
  a refused one for the socket would get through. Closing that needs the connection to be pinned to
  the address that was checked, which the database drivers and the S3 SDK do not offer. It is a
  narrower hole than the one this closes, and it is written here rather than pretended away.

The **executors** are not affected by any of this. They join their own network and reach your
databases on the host's connectivity, not the server container's; the guard governs connections
this process makes.

## Scratch holds your data in clear

`STAGED` backups write the dump to the scratch directory first, then compress, then encrypt, then upload.
The order is deliberate — you cannot compress ciphertext — and the consequence is that **while a
job runs, the scratch directory contains an unencrypted copy of your database**.

Your responsibilities:

- Put the scratch directory on a **dedicated volume**, not shared with anything else.
- Put that volume on an **encrypted filesystem**. Schrodump cannot do this for you; encryption at
  rest is a property of the host's storage, and a process cannot encrypt the disk it is writing to.
- Size it with `SCRATCH_MAX_BYTES` so a runaway dump fills a volume instead of the host's root
  filesystem.

Schrodump sweeps abandoned scratch directories at boot and periodically.

> **`docker stop` / `SIGTERM`.** The server installs a shutdown handler: it stops claiming new work,
> aborts the in-flight run (the runner force-kills that job's container), waits for the drain to
> settle under `SCHRODUMP_SHUTDOWN_GRACE_MS` (default 8s, `compose.yaml` gives it a 15s
> `stop_grace_period` to finish inside), then exits — releasing the scratch directory in the normal
> path, the same as any other job failure. The in-flight artifact upload is cancelled along with the
> dump, so the release no longer waits for a multipart upload to finish — which used to be the most
> likely way a drain overran its budget on a slow link. **Known limitation.** A `SIGKILL` — or a
> drain that outlasts the grace budget anyway — still bypasses this: the process exits immediately
> and the directory survives, in clear, until the next sweep.

> **Verified 2026-09-01 against the packaged image, with a real `docker stop`.** A backup was run
> against a real PostgreSQL origin (6M rows of incompressible data) in `STAGED` mode, so the dump
> was genuinely writing a cleartext directory to the scratch volume — the check waited for that
> directory to be _growing_, not merely to exist, because `pg_dump -Fd` creates its table of
> contents within the first second and stopping there tests nothing. Then `docker stop`.
>
> Result: no executor container left on the daemon, the scratch directory **gone**, the job row
> `FAILED` with reason `run aborted by shutdown`, and `docker stop` returned in **0.52s** — no
> `SIGKILL` needed. All four of the design's success criteria, including the signal-delivery leg
> (`dumb-init` → `entrypoint.sh` → Node) that an in-process check cannot cover.
>
> That leg is exactly where a defect was found. Before this run, one `docker stop` reached the
> server as **two** SIGTERMs — dumb-init broadcasting to the process group, and `entrypoint.sh`
> forwarding it again — and the handler, registered with `process.once`, died on the second one
> mid-cleanup. The executor was orphaned, the cleartext scratch survived, and the job stayed
> `RUNNING`. Measured both ways on the same build: a single signal completed the shutdown in 86ms;
> two never completed it at all.

### A verify's sandbox holds it too, and goes with its container

A `FULL_RESTORE` verify restores the artefact into a throwaway database server started from the
stock engine image (`postgres:<major>-alpine`, `mysql:8.0`, `mariadb:11`, `mongo:8`). Those images
declare a `VOLUME` for their data directory, so the restored database is written to an **anonymous
Docker volume** under Docker's data root (`/var/lib/docker/volumes` by default) — not to the scratch
directory, and in `STREAM` mode as much as in `STAGED`. For as long as the verify runs, that volume
is a complete, unencrypted copy of your database.

It is deleted with the container. Every container Schrodump creates — dump executors and verify
sandboxes, on success, failure, timeout and abort alike — is removed together with its anonymous
volumes (`docker rm -fv`; `v=true` in the API). **It was not always.** Removal used to pass `force`
alone, which stops the container and keeps its anonymous volumes: on a live stack three verifies
left three dangling volumes, each a complete PostgreSQL data directory, kept indefinitely. A daily
verify of a 50 GB database fills a host in days that way, and every artefact that was encrypted
before it left the host also existed in clear on it. Upgrading does not clean up what an earlier
version left behind — `docker volume ls -f dangling=true` lists the candidates, but it lists every
unreferenced volume on the host, not only Schrodump's, so inspect before you remove.

Your responsibilities are the scratch directory's, applied to Docker's data root:

- Put Docker's data root on an **encrypted filesystem** as well.
- Leave it room for the largest database you verify, restored — uncompressed, indexes included.

**Known limitation.** A `SIGKILL` of the server mid-verify skips the teardown, and nothing sweeps
containers today: the sandbox keeps **running**, volume and all. It is a stock engine image
attached to `EXECUTOR_NETWORK`; remove it with `docker rm -fv`.

## The session cookie is the operator, and HTTP gives it away

Schrodump authenticates with a session cookie and serves plain HTTP. That is a deliberate split of
responsibility — TLS termination belongs to the reverse proxy an operator already runs — but it
means an installation published straight to the network hands the cookie to anyone on the path.

The cookie is not a partial credential. Whoever holds it can read every target's host, port and
username, change a policy, and start a restore over a live database. There is no second factor
behind it. [install.md](install.md#put-it-behind-tls-this-is-not-optional) has the proxy configs;
publish 8080 to loopback only.

### The bootstrap password is a shared secret until it is rotated

`SCHRODUMP_ADMIN_PASSWORD` provisions the first admin without the setup link. That value is readable
with `docker inspect`, appears in shell history, and sits in `.env` on disk — so an account still
using it is not protected by a credential, it is protected by a value several people and one
process listing already have.

The `mustChangePassword` flag has always been set for that account. It is now **enforced**: while it
stands, every route behind `requireRole` refuses with `403 password_rotation_required`, whatever the
role. `GET /me` still answers, so the UI can explain rather than look broken, and Better-Auth's
change-password endpoint is reachable, so the way out is open. The UI replaces the whole application
with the rotation form rather than showing a banner over controls that would all fail.

Rotating revokes other sessions. The old password may already have opened one.

### Nobody can give themselves an account

There is no public sign-up. Better-Auth ships one and it is blocked at the route — `POST
/api/auth/sign-up/email` answers **404**, before the library sees the request. Every account is
created by the bootstrap or by an administrator through `POST /members`.

It was never a way in: an account created that way carried no membership, so every guarded route
answered 401. It was a way to take something. `User.email` is globally unique, so a stranger who
registered a colleague's address held it — an admin adding that person got a 409, permanently. And a
sign-up before the first administrator existed closed the setup link on a deployment that then had
no administrator and no way to create one.

### The login rate limit depends on knowing who is asking

Sign-in is limited to 5 attempts per address per five minutes, counted in Postgres so the limit is
shared across replicas and survives a restart. Which address it counts is decided by
`SCHRODUMP_TRUSTED_PROXIES`, and both ways of getting it wrong are real:

- **Unset, with a proxy in front.** `X-Forwarded-For` has several entries, none of them trusted,
  and the server refuses to guess. Every request in the deployment falls into one shared bucket, so
  five bad passwords from one person lock out everyone. A denial of service dressed as a control.
- **Unset, with nothing in front.** `X-Forwarded-For` is attacker-controlled. Rotating it per
  request gives each attempt a fresh bucket, and the limit never fires.

Set it to the CIDRs of the hops that are actually in front of the server, and configure the proxy
to **overwrite** `X-Forwarded-For` with the address it observed rather than appending to whatever
the client sent. Appending preserves the attacker's chosen prefix.

Passwords have a **server-side floor of 12 characters**, enforced on sign-up and on
change-password — not a client-side hint the API would accept around. Length is the only property
worth enforcing: composition rules push people toward predictable substitutions, and length is what
actually costs a guesser. `SCHRODUMP_ADMIN_PASSWORD` is checked against the same floor at boot, so a
short one is a legible startup failure naming the variable rather than a confusing auth error later.

Rate limiting is a cost multiplier on guessing, not a substitute for a strong password. Twelve
characters of `passwordpassword` is still `passwordpassword`.

### A signed-in operator is one framed click from a restore

The session cookie makes the browser the operator, and the two most destructive controls in the
product are a single click each: **restore over a live database**, and **delete a VERIFIED
artifact**. Put the interface in an invisible `<iframe>` on a page the operator was led to, line
the frame up under something they mean to click, and their own session does the rest. No password
is asked for again, because they are already signed in.

So every response says it may not be framed, twice over:

| Header | Sent by | Value |
| --- | --- | --- |
| `Content-Security-Policy` | UI (`apps/web/next.config.ts`) | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; frame-src 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'` |
| `Content-Security-Policy` | API (`@fastify/helmet`) | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` |
| `X-Frame-Options` | both | `DENY` |
| `X-Content-Type-Options` | both | `nosniff` |
| `Referrer-Policy` | both | `no-referrer` |

`frame-ancestors 'none'` is the control that matters; `X-Frame-Options: DENY` repeats it for
anything that predates CSP level 2. `no-referrer` keeps artifact ids and target names out of the
`Referer` of wherever the operator clicks next, and `nosniff` stops an error body from being read
back as a document. The two sides do not overlap on one response: the UI's `headers()` skips the
`/api/auth/` and `/backend/` prefixes it proxies, because the rewrite already forwards the API's
headers, and a browser enforces *every* `Content-Security-Policy` it is sent — two of them mean the
effective rule is the intersection of two policies nobody wrote together.

**Known limit: `script-src` keeps `'unsafe-inline'`, so the XSS half of the policy is weak.** Next
serves the React payload as a chain of inline `self.__next_f.push([...])` scripts whose content
differs per page and per build. No hash covers them; a nonce would have to come from middleware,
which means giving up the prerendered shell for every route. And a hash cannot simply be *added*:
the moment one is present, browsers ignore `'unsafe-inline'` — Next's own bootstrap included — and
the page never hydrates. There is no `'unsafe-eval'`: Zod's JIT probe is switched off
(`z.config({ jitless: true })`) rather than allowed for.

**No `Strict-Transport-Security` is sent by the application.** Schrodump serves plain HTTP and the
operator terminates TLS in front of it, so HSTS is the proxy's to send — see
[install.md](install.md#put-it-behind-tls-this-is-not-optional).

## The KEK belongs somewhere else

`SCHRODUMP_KEK` encrypts the data keys that encrypt every artefact. Keeping it on the host that
holds the backups defeats the encryption: an attacker who gets the host gets both halves.

- Keep it in a secrets manager and inject it at start, or read it from a mount that is not part
  of the backup set.
- Keep an offline copy. **Losing it loses every artefact**, permanently and by design.
- Verify the copy is the right one *before* you need it: `scripts/check-kek.mjs` answers that
  against the fingerprint the instance recorded, without booting it. A backup key you have never
  checked is in the same epistemic state as a backup you have never restored.
- Rotating it is a deliberate operation, not a config edit: Schrodump records a fingerprint of the
  KEK at first boot and refuses to start against a different one, precisely so that a wrong or
  swapped key fails loudly instead of producing artefacts nobody can open later.

Credentials are write-only from the interface's perspective. Once stored, they are never
decrypted for display and never sent back to the browser — the UI can replace a credential, never
reveal one.

## The two keys, and why only one of them can save you

Provisioning creates an operational key whose identity the server holds (KEK-wrapped, in the
metadata database) and an escrow key whose identity it never sees. That asymmetry is the design, not
an implementation shortcut.

The operational key is convenience: it lets the server verify and restore without an operator
fetching anything. It also lives inside the database it protects, so it dies with it.

The escrow key is the guarantee. Its identity is returned once, at creation, and persisted nowhere —
`encryptedIdentity` stays null by construction, and a test asserts the row written contains no trace
of it. An operator who prefers can supply their own public recipient instead, in which case the
server never generates a private half at all.

Losing the escrow identity is unrecoverable, and it is the failure that only shows up on the day it
matters. Store it the way you store the KEK: off this host, in a place that survives it.

## Rotating a key, and what rotation does not do

An admin can retire either key and issue its successor from **Settings → Encryption keys**, or with
`POST /encryption-keys/rotate`. Nothing is re-encrypted and nothing moves: the predecessor is marked
retired, not deleted, and every artifact already written stays readable through it. Restore resolves
its key from the artifact's own manifest rather than from current configuration, which is what makes
that safe — and the read paths never filtered on key state, deliberately, since before this
operation existed.

**Rotation is not remediation for a key that leaked.** This is the part worth reading twice. Every
artifact already in the bucket is still sealed to the outgoing recipient, and whoever holds the
outgoing identity can still open all of them. Rotating changes what the *next* backup is sealed to
and nothing else. If a key was exposed, the artifacts written under it are exposed too: re-take
those backups, or delete them. The API says this on every rotation, success included, rather than
answering with an id and letting a green screen imply the incident is closed.

The two keys differ in what rotation leaves you holding:

| Key           | After rotation                                                                       |
| ------------- | ------------------------------------------------------------------------------------ |
| `operational` | Nothing to do. The outgoing identity stays in the row, KEK-wrapped, and the server keeps opening older artifacts on its own. |
| `escrow`      | **Keep the outgoing identity.** The server never held it, and it is the only thing that can open self-backups and artifacts written before the rotation. |

So escrow identities accumulate: rotating escrow three times means three identities you must keep,
each one the sole key to the artifacts written in its era. Rotate escrow when you have a reason,
not on a schedule.

Rotation refuses in two states, both with `409`. A type with **no** active key needs provisioning,
not rotation — answering otherwise would hide that the organization never had one. A type with
**two** active keys means the recipient resolver has been choosing by row order, and picking one to
retire would be guessing which one it had been choosing; that state needs a human, not a default.

## Sealed mode: real custody separation

A destination can be marked **operational** or **sealed**.

- **Operational** — Schrodump holds the operational key. It can decrypt artefacts, which is what
  lets `FULL_RESTORE` verification actually restore the dump and check it.
- **Sealed** — artefacts are encrypted to the **escrow** recipient alone. Schrodump never stores
  the escrow identity (it is shown once at provisioning or rotation and kept by you), so it can
  write these artefacts and never read them. Schrodump does not restore them: a restore runs outside
  it, with the escrow identity — `scripts/rehearse-recovery.sh` is the procedure, and it uses
  nothing from Schrodump on purpose. The interface withholds the restore on a sealed artefact with
  that reason.

> **Until the pre-launch audit, sealed was not sealed.** Every artefact was encrypted to the
> operational key as well, whose identity Schrodump holds KEK-wrapped in its own database, so a
> compromised instance could open a sealed destination's artefacts; the setting only cost them
> their restore-verification. Artefacts written to a sealed destination before that fix are still
> sealed to both keys and still openable by this instance — each artefact's `keyIds` in its
> manifest says which it is, and the catalogue shows it as restorable. Re-take them if the
> separation matters for them.

Sealed mode is the honest answer to "what if Schrodump itself is compromised". An attacker with
full control of a sealed instance can destroy your ability to take new backups; they cannot read
the ones already written.

> **The cost is stated plainly: on a sealed destination, verification degrades to checksum.**
> Schrodump can confirm the artefact is the size and shape it wrote, and that it has not been
> altered. It cannot confirm the dump restores, because it cannot open it. If you seal a
> destination, verification is no longer answering the question the project exists to answer, and
> you should be restoring from it manually on a schedule you set.

Every artefact on an operational destination is encrypted to **two** recipients: the operational
key and an escrow key, so one lost key is not one lost backup. On a sealed destination it is the
escrow key alone — which makes that identity the only copy of the ability to read those
artefacts. Keep it as carefully as the KEK.

## Executors

Dumps run in ephemeral containers, one per job, built from the target's own major version.

- Images are **pinned by version, and the ones we build are pinned by digest**. An executor that
  floats changes how backups are produced without anyone deciding it.
- Passwords never reach `argv` — an argument list is readable by any process on the host. They go
  through the environment or a mounted config file, depending on what the tool supports.
- Executors join a restricted network and mount nothing but the staging directory they need —
  plus the anonymous volume Docker creates for any `VOLUME` their image declares, which is
  removed with the container ([above](#a-verifys-sandbox-holds-it-too-and-goes-with-its-container)).
- They do not run as an unprivileged user, deliberately: they read and write a staging directory
  whose ownership the server controls, and forcing a different uid would break those writes rather
  than contain anything. Containment comes from the container being ephemeral, having no socket
  access and mounting nothing else.

## The connection to your database, and what each TLS mode verifies

A target has three TLS modes, and Schrodump applies each one **identically** to the connection test,
the probe every backup starts with, and every tool that connects — `pg_dump`, `pg_dumpall`,
`pg_restore`, `psql`, `mysqldump`/`mariadb-dump`, the `mysql`/`mariadb` client, `mongodump`,
`mongorestore`. A connection test that passes is a backup that can connect, and the reverse. (The
verify sandbox is a throwaway container on the executor network and never connects to your
database.)

| Target settings                | What is checked                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS off                        | Nothing. The password and every dump cross the network in the clear. An explicit choice, recorded on the target.                                                           |
| TLS on, no CA certificate      | **PostgreSQL, MySQL, MariaDB:** encrypted; the server's certificate is **not** verified (libpq's `sslmode=require`). Anyone who can sit in the path can pose as the server. **MongoDB:** encrypted and verified against the system trust store, which is the tools' own default and covers Atlas and other public CAs. |
| TLS on, with a CA certificate  | Encrypted; the certificate chain verified against **that CA only**, and the host name checked against the certificate — libpq `verify-full`, MySQL `VERIFY_IDENTITY`, MariaDB `--ssl-verify-server-cert`, mongo `--sslCAFile`. |

The CA certificate is public and is stored as it is, in clear, on the target row and returned by the
API: it is not a credential, and wrapping it like one would suggest a protection it does not need.
The API accepts only PEM certificates it can parse, and refuses any other PEM block outright — the
likeliest wrong paste is the server's private key, and this field is shown to every viewer.

The tools read the CA from a file: the server writes it onto the scratch volume and bind-mounts it
**read-only** into the executor at `/etc/schrodump/tls-ca.pem`, the same way the mongo `--config`
password file travels. A target with a CA therefore needs `SCHRODUMP_SCRATCH_PATH` configured; without
it the backup fails at once and says so.

What is not covered:

- **A staged MySQL/MariaDB dump requires a CA to use TLS.** `mydumper`/`myloader` (MariaDB
  Connector/C) have no way to require TLS without verifying it: `--ssl-mode=REQUIRED` completed a
  whole dump against a server with TLS switched off, in plaintext (measured). With a CA they verify
  properly. So a TLS target without a CA is never staged — the policy's staged request streams
  instead, and the job says why — and a staged artifact is not restored into such a target.
- **The MariaDB client below 11.4 has no "required but unverified" mode.** `--ssl` encrypts when the
  server offers TLS and falls back to plaintext when it does not; 11.4 and later clients verify by
  default and refuse plaintext. The probe that runs first, against the same server, refuses a server
  that offers no TLS, so a backup never reaches the client against one — but against an active
  attacker, unverified TLS was never a defence. Paste the CA.
- **For MySQL/MariaDB, give a verified target the host NAME on its certificate.** For an IP address
  the probe's driver (mysql2) checks the certificate against `localhost` before logging in, and
  Schrodump checks it against the address only once the connection is up — so an IP works only when
  the certificate names both, and the login has already happened when the second check runs.

## Supply chain

A backup tool is a high-value target: compromise the image, and you have credentials for every
database of every operator who pulled it.

- Every published image is **signed with cosign** (v3, pinned in `release.yml`), keyless via OIDC.
  There is no signing key to steal. Verify before running — the command, and the client version it
  needs, are in [install.md](install.md#upgrading). The version is not incidental: a cosign v2
  client cannot read a v3 signature and answers `no signatures found`, which reads exactly like an
  unsigned image.
- Every published image carries an **SBOM** and provenance attestation, so what is inside it is a
  question with an answer.
- CI scans dependencies, scans the built image, checks for committed secrets and verifies licence
  headers on every change and weekly on a schedule, because advisories land against code that has
  not changed.
- The image ships **no database clients**. That is an architectural rule with a security payoff:
  the server's attack surface does not include five database client libraries it never calls.
- The image ships **no package manager**. npm, corepack and yarn are removed from the base: the
  entrypoint calls none of them, npm alone accounted for most of the advisories reported against
  the image, and a way to fetch and run arbitrary code is not something a container holding
  database credentials should have lying around.

### What the dependency audit still reports, and why

`pnpm audit` is printed in full on every run and only **critical** fails the build — a gate that is
permanently red because upstream has not shipped a patch teaches people to ignore it. So the
remainder is listed here rather than left for the reader to re-derive:

| Advisory | Reaches | Why it stays |
| --- | --- | --- |
| `vitest` / `@vitest/mocker` (moderate) | the test runner | Fixed in 4.x. A major bump of the runner is its own change with its own risk, and no part of it is in the published image. |
| `deepmerge-ts` (high) | `prisma` → `@prisma/config` | The Prisma CLI, at build and migrate time. Not in the runtime, and not ours to bump — it moves when Prisma moves. |
| `uuid` (moderate) | `dockerode` → `uuid` | Runtime, and the only one here that is. The flaw is a missing bounds check in `v3`/`v5`/`v6` **when a `buf` is supplied**; nothing in this codebase calls those, and forcing a major of a transitive we cannot exercise without a Docker daemon trades a real risk for a theoretical one. |

Every direct dependency is at a version with no open advisory. If any of the three above reaches
critical, or a fix lands upstream, it moves — the weekly scheduled scan exists so that "no change
here" does not mean "nobody looked".

### Was known, now fixed: `sharp` no longer ships in the image

Next traces `sharp` into the standalone build, so `sharp` and its bundled `libvips` used to be
present in the published image and flagged by image scanning (libvips CVEs, fixed in `sharp` 0.35).
The web interface uses no `<Image>` and sets no `images` config, so the code was never loaded — but
it shipped, and "present but unreachable" is a weaker claim than "absent".

The build now deletes it (`docker/Dockerfile`, next to the Prisma engine cuts), which took 17.5 MB
out of the web runtime. `outputFileTracingExcludes` does not cover it — Next special-cases `sharp`
for the standalone server and copies it regardless of the exclude globs — so the cut is a `rm` in
the image build, and the container smoke test is what proves it safe: if the UI ever does need
`sharp`, it fails on boot with a missing module rather than silently.

What remains is roughly 12 KB of dangling symlinks in `.pnpm/node_modules` whose targets are gone.
`docker/prune-store.mjs` preserves that directory wholesale because removing it breaks every
`require`. They contain no code and no libvips binary.

## Reporting a vulnerability

Do not open a public issue. Follow [`SECURITY.md`](../SECURITY.md).
