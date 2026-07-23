# Logical backups, and why verification is not optional

## What a logical backup is

A logical backup is a description of your data as statements: `CREATE TABLE`, `INSERT`, index
definitions. It is what `pg_dump`, `mysqldump` and `mongodump` produce. Restoring one means
replaying that description into a running server.

This is different from a physical backup, which copies the database's files on disk.

|                                   | Logical                     | Physical                       |
| --------------------------------- | --------------------------- | ------------------------------ |
| Restore to a different version    | Yes                         | Usually no                     |
| Restore a single table            | Yes                         | No                             |
| Restore to a point in time        | No                          | Yes, with WAL/binlog           |
| Cost on a large database          | High — hours                | Low — a file copy              |
| Needs an agent on the DB host     | No                          | Yes                            |
| Portable across platforms         | Yes                         | Rarely                         |

Schrodump does logical backups only. That choice is what makes it agentless: nothing is installed
on your database server, because everything runs through the client protocol from an ephemeral
container.

## What logical backups do not cover

State this out loud before you rely on it:

- **No point-in-time recovery.** You restore to the moment the dump ran, not to 14:32 yesterday.
  If you need PITR, you need physical backups with continuous WAL or binlog archiving. Schrodump
  does not do that and does not pretend to.
- **Restore time grows with the data.** Replaying a dump means re-running every insert and
  rebuilding every index. A dump that takes one hour to produce can take several to restore. Test
  it before you need the number.
- **Not everything is in the dump.** Roles, tablespaces, server configuration and extensions can
  live outside a database-scoped dump. What is included depends on the engine and the scope you
  chose.
- **A dump is a moving target unless the engine gives you a snapshot.** Schrodump uses each
  engine's consistent-snapshot mechanism where one exists. Where it does not, the dump is
  consistent per table, not across tables.

If your recovery objective is measured in minutes, logical backups alone are not the answer. They
are the answer to "the data still exists somewhere I can read it", which is the failure everyone
actually has.

## Why verification exists

Here is the problem the project is named after.

A backup job that exits zero has proven one thing: a process ran and did not report an error. It
has not proven that the file in your bucket contains your data. All of these produce a green job
and an unusable artefact:

- Credentials that can write to the bucket but not read from it.
- A dump that was truncated when a connection dropped, and the exit code came from the wrong end
  of the pipe.
- Compression or encryption that silently produced an empty stream.
- A retention rule that deleted the last good copy an hour before you needed it.
- A schema the dump can produce but the restore cannot replay.

None of these are exotic. They are the normal way backups fail: **quietly, and only observably at
restore time**, which is the one moment you cannot afford to find out.

So Schrodump refuses to describe an artefact as good because a job exited zero. Every artefact is
in exactly one of three states:

| State        | Colour | What it means                                                            |
| ------------ | ------ | ------------------------------------------------------------------------ |
| `VERIFIED`   | green  | Something opened it and checked. It restores                              |
| `UNOBSERVED` | amber  | It was written. Nothing has looked inside. It may be perfect, or empty    |
| `FAILED`     | red    | It was checked and it is not good                                         |

There is no "OK". `UNOBSERVED` is deliberately amber and never grey, because grey reads as
"fine, nothing to see" and that is precisely the wrong conclusion. An unverified backup is an
open question, and the dashboard's primary counter is the number of open questions you have —
not the number of jobs that succeeded.

## Verification levels

Set per policy:

- **`NONE`** — no verification. Every artefact this policy produces stays `UNOBSERVED` forever.
  Schrodump shows a permanent warning on any policy configured this way. Not a toast that fades:
  the condition persists, so the warning persists.
- **`CHECKSUM`** — the artefact is read back from the destination and its checksum compared.
  Catches truncation, corruption in transit, and a destination that cannot serve back what it
  accepted. Does not catch a dump that is intact but not restorable.
- **`FULL_RESTORE`** — the artefact is restored into a disposable database and checked. This is
  the only level that answers the actual question. It costs what a restore costs, which is why it
  is a choice and not a default.

On a **sealed** destination, `FULL_RESTORE` degrades to `CHECKSUM` — Schrodump does not hold the
key to open the artefact. That trade is described in
[security.md](security.md#sealed-mode-real-custody-separation).

## Restoring

Restore is deliberately harder to trigger than backup.

- **Only operators and administrators can restore.** A viewer does not see the control, and the
  server rejects the request regardless of what the browser sends. The interface hiding a button
  is a convenience; the server refusing the call is the control.
- **Scopes are constrained by the engine.** PostgreSQL can restore a cluster, a database, a schema
  or a table; MySQL and MariaDB have no schema level; MongoDB restores collections rather than
  schemas. Scopes the engine cannot do are shown disabled with the reason, instead of being
  offered and failing later.
- **Restoring over an existing database requires typing its name.** The friction is the point.
  Restore is one of the few operations that destroys data faster than any incident, and it is
  usually run by someone under pressure at an hour they would rather be asleep.

Every restore is recorded: who, what artefact, which scope, when.

## Practical advice

- Turn `FULL_RESTORE` on for at least one policy per database, even if it is weekly. A checksum
  proves the bytes survived; only a restore proves the data did.
- Watch the unobserved counter, not the job list. A green job list with a rising unobserved count
  is a system that is backing up and never checking.
- Do a restore drill on a schedule, by hand, to a real target. Automated verification tells you
  the artefact is good. A drill tells you whether *you* can carry out a restore under pressure,
  which is a different question, and the one that decides how the incident goes.
