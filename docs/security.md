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

## The Docker socket is the most critical asset

Schrodump starts containers to run dumps. That requires access to the Docker API, and
**unrestricted access to the Docker socket is equivalent to root on the host** — anyone who can
create a container can mount `/` into it.

This is why the default `compose.yaml` does not mount the socket into Schrodump. It mounts it
read-only into `tecnativa/docker-socket-proxy`, which exposes only the endpoints Schrodump needs:

```yaml
CONTAINERS: 1 # create and inspect executors
IMAGES: 1 # pull executor images
NETWORKS: 1 # attach executors to the target network
INFO: 1
POST: 1
EXEC: 0 # no docker exec into a running container
VOLUMES: 0 # no volume creation, so no mounting the host filesystem
```

`EXEC: 0` and `VOLUMES: 0` are the two that matter. With `EXEC` a compromised Schrodump could run
commands inside any container on the host; with `VOLUMES` it could create a container that mounts
the host root. Neither is needed to take a backup.

The proxy image is pinned to an exact version, for the same reason: the component enforcing this
boundary must not change without someone deciding that it should.

**If you replace this arrangement**, understand what you are accepting. Mounting
`/var/run/docker.sock` directly into Schrodump means a remote-code-execution bug in Schrodump is
a host takeover, not a service compromise.

## Scratch holds your data in clear

`STAGED` backups write the dump to `/scratch` first, then compress, then encrypt, then upload.
The order is deliberate — you cannot compress ciphertext — and the consequence is that **while a
job runs, `/scratch` contains an unencrypted copy of your database**.

Your responsibilities:

- Put `/scratch` on a **dedicated volume**, not shared with anything else.
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

## The KEK belongs somewhere else

`SCHRODUMP_KEK` encrypts the data keys that encrypt every artefact. Keeping it on the host that
holds the backups defeats the encryption: an attacker who gets the host gets both halves.

- Keep it in a secrets manager and inject it at start, or read it from a mount that is not part
  of the backup set.
- Keep an offline copy. **Losing it loses every artefact**, permanently and by design.
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

## Sealed mode: real custody separation

A destination can be marked **operational** or **sealed**.

- **Operational** — Schrodump holds the operational key. It can decrypt artefacts, which is what
  lets `FULL_RESTORE` verification actually restore the dump and check it.
- **Sealed** — Schrodump holds only public recipients. It can write artefacts and never read
  them. Decryption requires an identity the operator supplies in memory at restore time.

Sealed mode is the honest answer to "what if Schrodump itself is compromised". An attacker with
full control of a sealed instance can destroy your ability to take new backups; they cannot read
the ones already written.

> **The cost is stated plainly: on a sealed destination, verification degrades to checksum.**
> Schrodump can confirm the artefact is the size and shape it wrote, and that it has not been
> altered. It cannot confirm the dump restores, because it cannot open it. If you seal a
> destination, verification is no longer answering the question the project exists to answer, and
> you should be restoring from it manually on a schedule you set.

Every artefact is encrypted to **two** recipients: the operational key and an escrow key. One
lost key is not one lost backup.

## Executors

Dumps run in ephemeral containers, one per job, built from the target's own major version.

- Images are **pinned by version, and the ones we build are pinned by digest**. An executor that
  floats changes how backups are produced without anyone deciding it.
- Passwords never reach `argv` — an argument list is readable by any process on the host. They go
  through the environment or a mounted config file, depending on what the tool supports.
- Executors join a restricted network and mount nothing but the staging directory they need.
- They do not run as an unprivileged user, deliberately: they read and write a staging directory
  whose ownership the server controls, and forcing a different uid would break those writes rather
  than contain anything. Containment comes from the container being ephemeral, having no socket
  access and mounting nothing else.

## Supply chain

A backup tool is a high-value target: compromise the image, and you have credentials for every
database of every operator who pulled it.

- Every published image is **signed with cosign**, keyless via OIDC. There is no signing key to
  steal. Verify before running — the command is in [install.md](install.md#upgrading).
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

### Known: `sharp` ships in the image

Next traces `sharp` into the standalone build, so `sharp` and its bundled `libvips` are present
in the published image and are flagged by image scanning (libvips CVEs, fixed in `sharp` 0.35).
The web interface does not use Next's image optimisation, so the code is never loaded — but it is
shipped, and "present but unreachable" is a weaker claim than "absent". Removing it is a
build-configuration change, tracked separately.

## Reporting a vulnerability

Do not open a public issue. Follow [`SECURITY.md`](../SECURITY.md).
