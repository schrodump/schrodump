# Scope of v1, and what is deliberately outside it

What follows is not a wishlist. It is the set of things that were considered, understood, and
left out — with the reason, so that the decision can be re-examined when the reason changes.

A backup tool that does one thing verifiably is worth more than one that does six things you
have to trust.

## Outside v1, on purpose

### Physical backups and point-in-time recovery

The single most requested capability, and the one with the clearest reason to be absent.

PITR means continuously archiving WAL (PostgreSQL) or binlogs (MySQL) and being able to replay to
an arbitrary moment. That requires a process **on the database host**: reading the data directory,
hooking `archive_command`, holding a backup label across a file-level copy. There is no way to do
it through the client protocol from a container somewhere else.

Schrodump's defining property is that it is agentless — nothing installed on your database
server, nothing to upgrade there, no new privileged process on the machine that holds your data.
PITR is incompatible with that property, not merely unimplemented. It waits for the agent.

Until then, be explicit with yourself: **your recovery point is the last dump, and your recovery
time is however long a restore takes.** Measure both. If either number is unacceptable, you need
physical backups, and Schrodump is not that tool yet.

### The agent, and why it would be written in Go

The agent is the prerequisite for physical backups, PITR and much faster large-database dumps.
It is not in v1 because it is a different product surface: an installed component, on a host
someone else owns, with its own upgrade path, its own privileges, and its own blast radius.

When it is written, it will not be written in Node. Not out of preference — because **Node is not
installable on a production database host** in the environments that matter. It is a runtime plus
a dependency tree plus a package manager on a machine whose owner has spent years keeping exactly
that off it. A Go binary is a single static file with no runtime, no dependency resolution at
install time, and a straightforward story for whoever has to approve putting it there. That
approval is the actual constraint, and it decides the language.

The server stays in Node. The agent is where the constraint is different, so the answer is
different.

### Local filesystem destinations

Storing backups on the same machine that runs Schrodump, or on a mounted NFS share, is not
supported.

The omission is a position, not an oversight. A backup on the host that holds the database
protects you from `DROP TABLE` and from nothing else — not disk failure, not ransomware, not the
fire. Offering it as a first-class destination makes the least useful configuration the easiest
one to choose, and it would be chosen, because it is the one that requires no credentials and no
bucket.

S3-compatible means MinIO too. A MinIO instance on another machine is a supported destination,
takes minutes to run, and is a genuinely different failure domain. That is the path.

### S3 Object Lock

Object Lock (WORM) makes artefacts undeletable for a fixed window — the standard defence against
an attacker who takes your infrastructure and deletes the backups before encrypting the primary.

It is out of v1 because it is not a checkbox. Object Lock changes retention from something
Schrodump decides into something the storage enforces, and the two must agree or the catalogue
starts describing artefacts it cannot delete. It also collides directly with the right to
elimination — see [lgpd.md](lgpd.md#the-hard-part-object-lock-versus-the-right-to-elimination),
which sets out the position to design against.

Shipping it half-right would be worse than not shipping it: a retention policy the operator
believes is running, silently failing against a lock they configured elsewhere.

### Notifications: SMTP and webhooks

There is no email and there is no webhook in v1. A backup tool that cannot tell you it is failing
is a backup tool you will stop looking at.

The reason for the delay is that notification design decides whether the tool is useful or
ignored. Alert on every job and it becomes noise that gets filtered within a week; alert only on
failure and the worst case — **jobs succeeding, nothing being verified** — stays silent, which is
exactly the state the whole project exists to make visible.

The right trigger is a change in the unobserved count, not a job result. That deserves to be
designed rather than bolted on, and it is the first thing after v1.

In the meantime the dashboard leads with the number of unobserved backups, and `/health` is
available to whatever monitoring you already run.

## Known limitations shipping in v1

Not scope decisions — things that are incomplete or sharp, verified, and written down so nobody
discovers them during an incident.

| Limitation                                                                       | Consequence                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Restore execution is not wired: the endpoint accepts the request and returns 501   | Restores are planned in the interface but not carried out by the server yet     |
| No `SIGTERM` handler in the server or runner                                       | A container killed mid-job leaves its scratch directory, holding a dump in clear, until the next sweep |
| The interface cannot read the caller's role — no endpoint exposes it               | The restore control is hidden from everyone; the server's operator-only check is what actually enforces it |
| Integration tests pin PostgreSQL 16, MySQL 8.0 and MongoDB 8 inside the test file  | The supported-range edges (13 and 18), MariaDB and replica sets are untested in CI |
| `sharp` is traced into the image by Next and carries known libvips advisories      | Flagged by image scanning; the code is never loaded, but it is shipped          |
| The production image is ~635 MB against a 400 MB target                            | Prisma's client and CLI account for roughly 275 MB of it; see the note below    |

### On image size

The target was under 400 MB and it is not met. The floor for this stack is roughly 450 MB before
any application code: Node on Alpine is ~170 MB, the Prisma client with its native query engine
is ~90 MB, the Prisma CLI needed for `migrate deploy` is ~115 MB, and the Next standalone output
is ~40 MB.

The build already prunes what it can — the dependency tree is reduced to the runtime closure
(~600 MB removed), and Prisma's WASM engines for database vendors Schrodump does not use are
deleted. Getting materially below 450 MB means changing how migrations are applied, or how the
metadata layer reaches PostgreSQL. Both are real options; neither is a Dockerfile change.
