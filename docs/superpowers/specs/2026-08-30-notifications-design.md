# Notifications — design

- **Date:** 2026-08-30
- **Status:** draft, awaiting review
- **Scope:** tell an operator when the fleet's **open questions** change, over SMTP and webhooks.

## The position this inherits

`docs/roadmap.md` already argued the hard part, and this design does not reopen it:

> Alert on every job and it becomes noise that gets filtered within a week; alert only on failure
> and the worst case — **jobs succeeding, nothing being verified** — stays silent, which is exactly
> the state the whole project exists to make visible.

So the unit of notification is **not a job**. It is a change in what the fleet has and has not
proven.

## What is watched

Per organization, evaluated on a tick: the count of artifacts by state — `VERIFIED`, `UNOBSERVED`,
`FAILED` — and, per policy, when a backup last succeeded.

## The four triggers

1. **An artifact was proven bad.** Verify restored it and the restore did not produce a usable
   database, so the artifact is `FAILED`. Immediate, never batched, not configurable off. This is
   the highest-signal event the system can produce: not a process complaining, a claim about data.

2. **Verification is falling behind.** The `UNOBSERVED` count rose and stayed risen across
   consecutive evaluations. The hysteresis is the whole point: every backup is briefly `UNOBSERVED`
   between finishing and its chained verify, so a trigger without it would fire on every healthy
   backup and be filtered within a week — the exact failure the roadmap names. Default: risen at
   two consecutive evaluations, at least 15 minutes apart.

3. **A policy went quiet.** No successful backup for longer than twice its cron interval. This is
   the silent death — the scheduler wedged, the target unreachable, credentials rotated — and it is
   invisible to any failure-based alert, because a job that never runs never fails.

4. **Delivery itself is failing** (surfaced on the dashboard, not sent). A notifier that cannot
   reach its channel must not be silent about it, or the whole feature degrades into false comfort.

Deliberately NOT a trigger by default: an individual job succeeding, or an individual backup
failing. A single failed backup that the next scheduled run repairs is noise; a policy that keeps
failing is trigger 3. Per-failure alerts are available as an opt-in for operators who want them,
off by default, with this reasoning in the docs beside the switch.

## Not repeating itself

A condition that stays true must not re-send every tick. Each organization holds the last delivered
state per trigger; a notification is sent when the condition **transitions**, and resolves — with a
closing message — when it stops holding. A condition that has held for a long time is re-asserted on
a slow cadence (weekly) so a persistent problem is not forgotten rather than being re-sent hourly
until it is muted.

## Delivery

- **Webhook.** A POST with a stable JSON envelope, an idempotency key, and an HMAC signature over
  the body using a per-destination secret. The secret is envelope-encrypted with the KEK exactly as
  target and destination credentials are — the crypto rules in `apps/server/CLAUDE.md` apply
  unchanged, and nothing about a notification is exempt from them.
- **SMTP.** Host, port, username and an envelope-encrypted password. Same rule: write-only from the
  interface's perspective, never decrypted for display.

Payloads carry counts, policy names and artifact ids. They carry **no** connection strings, no
credentials, and no data samples — a notification leaves the trust boundary, so the manifest's rigid
rules are the right precedent.

## Where it runs

The scheduler tick already runs periodically under its own advisory lock, single-flight across
replicas. Evaluation belongs there, in its own pure module (`notifications/evaluate.ts`) taking a
snapshot and the last delivered state and returning the notifications to send — testable without a
database, in the shape `scheduler/` and `jobs/` already use. Delivery is the wiring layer's job.

**A notification failure must never fail a job.** Delivery is not in any job's path; it reads
committed state after the fact.

## Out of scope

- Per-user preferences and routing rules. One channel set per organization.
- Paging integrations. A webhook into whatever the operator already runs covers it.
- Localised message bodies. English, per the project's language policy; the UI copy layer is
  separate.

## Testing

The evaluator is pure: snapshot plus last-delivered state in, notifications out. Every trigger gets
a test, and so does every **non**-trigger — a healthy backup that is briefly `UNOBSERVED` must
produce nothing, and that test is the one that keeps this feature from becoming noise. Delivery is
tested against a local HTTP sink and a fake SMTP; signature verification gets its own test, since a
webhook nobody can authenticate is a webhook nobody should act on.
