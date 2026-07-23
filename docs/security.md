# Security model

Schrodump holds credentials for every database you point it at and can start containers on the
host that runs it. That combination is the whole threat model: it is a single box whose
compromise is not one service but your entire database estate, plus the backups that would have
been the way back.

This document states what is protected, what is not, and which parts are your responsibility
rather than the software's.

## What an attacker gets from each piece

| If they get…                  | They get…                                                            |
| ----------------------------- | -------------------------------------------------------------------- |
| The Docker socket             | Root on the host. Everything below stops mattering                    |
| The metadata database + KEK   | Every stored database credential                                      |
| The metadata database alone   | Credential ciphertext, useless without the KEK                        |
| The bucket + artefact keys    | Your data                                                             |
| The bucket alone              | Encrypted artefacts and their sizes and timing                        |
| The scratch volume mid-job    | One database dump, in clear                                           |

## The Docker socket is the most critical asset

Schrodump starts containers to run dumps. That requires access to the Docker API, and
**unrestricted access to the Docker socket is equivalent to root on the host** — anyone who can
create a container can mount `/` into it.

This is why the default `compose.yaml` does not mount the socket into Schrodump. It mounts it
read-only into `tecnativa/docker-socket-proxy`, which exposes only the endpoints Schrodump needs:

```yaml
CONTAINERS: 1 # create and inspect executors
IMAGES: 1     # pull executor images
NETWORKS: 1   # attach executors to the target network
INFO: 1
POST: 1
EXEC: 0       # no docker exec into a running container
VOLUMES: 0    # no volume creation, so no mounting the host filesystem
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

> **Known limitation.** A container killed mid-job does **not** release its scratch directory:
> neither the server nor the runner installs a `SIGTERM` handler today, so the process exits
> immediately and the directory survives until the next sweep. The dump in it is in clear for that
> window. Signal delivery itself works — `docker stop` reaches the process and shuts it down
> cleanly — but the cleanup on the way out does not exist yet.

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

### Known: `sharp` ships in the image

Next traces `sharp` into the standalone build, so `sharp` and its bundled `libvips` are present
in the published image and are flagged by image scanning (libvips CVEs, fixed in `sharp` 0.35).
The web interface does not use Next's image optimisation, so the code is never loaded — but it is
shipped, and "present but unreachable" is a weaker claim than "absent". Removing it is a
build-configuration change, tracked separately.

## Reporting a vulnerability

Do not open a public issue. Follow [`SECURITY.md`](../SECURITY.md).
