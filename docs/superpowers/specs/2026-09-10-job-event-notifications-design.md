# Job-event notifications — design

## The question this answers

An operator ran several policies by hand and received nothing. That is the product working as
designed: `evaluate.ts` emits three triggers — `ARTIFACT_FAILED`, `VERIFICATION_BEHIND`,
`POLICY_QUIET` — and "a job ran" is not one of them. `ARCHITECTURE.md` records why: **the unit is
the fleet, not the job**, because a channel that fires on every job is a channel filtered into a
folder within a week, and the three alerts that matter die with it.

That reasoning is sound and is **not** reversed here. What it does not cover is the operator who
wants a stream of job outcomes — validating a fresh deployment, feeding a dashboard, keeping an
audit trail outside the database. Today the only way to see a job is to open the UI.

## The decision

Job events are a **per-channel opt-in**, defaulting to off. A channel is either:

- **fleet only** (default, today's behaviour) — the three triggers, and nothing else;
- **fleet + job events** — the three triggers *plus* one delivery per job state transition.

The fleet default is untouched, so nothing changes for a deployment that does not ask. The
architecture decision keeps its meaning: alerting is still fleet-level, and job events are an
explicitly requested firehose, labelled as such in the interface.

**Every transition, not only the terminal state.** `PENDING → RUNNING → SUCCEEDED` is three
deliveries. An operator who opts into a firehose wants to see a job start, not only learn later
that it finished.

## Why a database trigger

The capture mechanism has to be exhaustive, or "every job" is an intention rather than a guarantee.

The decisive fact is that `claimNextJob` (`jobs/claim.ts`) flips `PENDING → RUNNING` in **raw SQL** —
`UPDATE "BackupJob" SET state = 'RUNNING' ... FOR UPDATE SKIP LOCKED` — because the claim has to be
atomic against concurrent workers. A Prisma client extension, the mechanism `data/scope.ts` already
uses for `organizationId`, never sees that statement. Any TypeScript-side hook would miss the single
most common transition in the system.

So the outbox row is written by an `AFTER INSERT OR UPDATE OF state` trigger on `BackupJob`:

- it sees the raw-SQL claim, the worker's `setJobState` and `failJob`, the scheduler's orphan
  recovery, and both `create` sites — and it will see whatever is added next year by someone who
  never read this file;
- it writes in the **same transaction** as the state change, so an event cannot be lost to a crash
  between the two writes, and cannot be observed out of order with the state it describes.

The cost is real and worth stating: this is the **first trigger in the project**, it puts one piece
of behaviour outside TypeScript where every other rule lives, and it can only be tested against a
real PostgreSQL. That last point is the mitigation — the integration suite already stands one up,
and the trigger gets a test there that asserts the raw-SQL claim produces a row.

## Why an outbox rather than delivery at the transition

Delivery must never sit in a job's path. `apps/server/CLAUDE.md` states it plainly: *a notification
that fails must never fail a backup*. The trigger writes a row and returns; a later pass reads
committed rows and delivers them. The job's transaction does no network I/O.

Polling job state directly instead of an outbox was rejected: `PENDING → RUNNING → SUCCEEDED` can
happen entirely between two 30-second ticks, and a poller reading current state would report one
transition where three occurred.

## Delivery semantics

- **At least once.** An event is marked delivered after the pass that attempted it, whether or not
  every channel accepted it — the same trade-off `notificationState` already makes, and for the same
  reason: otherwise one dead channel replays the whole backlog to the healthy ones forever. The
  per-channel failure is recorded on the channel row, which is the thing to watch.
- **Idempotency-keyed per transition.** `Idempotency-Key` already derives from the condition rather
  than the moment. For a job event the job's *state* joins the key, or every transition of one job
  would carry the same key and a deduplicating receiver would drop two of the three.
- **Bounded per pass.** A burst cannot make one tick unbounded; the drain takes at most
  `JOB_EVENT_DRAIN_LIMIT` events and leaves the rest for the next tick.
- **Pruned.** Delivered rows older than 24 hours are deleted by the same pass. With no channel
  opted in, events are marked delivered immediately and collected on the next sweep, so the trigger
  cannot grow a table nobody reads.

## Wire shape

```json
{ "trigger": "JOB_STATE",
  "key": "<jobId>",
  "kind": "occurred",
  "summary": "BACKUP job for policy \"shop-daily\" is RUNNING",
  "job": { "id": "…", "kind": "BACKUP", "state": "RUNNING", "policyId": "…" } }
```

`"occurred"` is a third `kind` alongside `opened`/`resolved`: a job transition neither opens nor
resolves a condition, and claiming otherwise would make the two words meaningless. `job` is absent
from the three fleet triggers and from `TEST`. Both additions are additive for receivers.

`JOB_STATE` widens the **wire** vocabulary only. `evaluate.ts` keeps its exhaustive three, because
nothing about a fleet snapshot produces a job transition — it is read from the outbox, not derived.
