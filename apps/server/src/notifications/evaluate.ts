// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What to tell an operator, and — mostly — what not to.
//
// The unit here is NOT a job. docs/roadmap.md argued why: alert on every job and it is filtered
// within a week; alert only on failure and the worst case, jobs succeeding while nothing is
// verified, stays silent. So this evaluates a change in what the fleet has and has not PROVEN.
//
// Pure by design: a snapshot, the previous snapshot, and what has already been reported go in;
// notifications come out. No database, no clock, no delivery — all three are the wiring's job, and
// keeping them out is what makes every trigger and every NON-trigger testable.

export type NotificationTrigger = "ARTIFACT_FAILED" | "VERIFICATION_BEHIND" | "POLICY_QUIET";

export interface PolicyHealth {
  readonly id: string;
  readonly name: string;
  // How often this policy is expected to produce a backup, from its cron.
  readonly expectedIntervalMs: number;
  readonly lastSucceededAt: Date | null;
}

export interface FleetSnapshot {
  readonly at: Date;
  // Artifacts nobody has looked at. The dashboard's headline number.
  readonly unobserved: number;
  // Artifacts a verify restored and found unusable — proven bad, not merely unseen.
  readonly failedArtifactIds: readonly string[];
  readonly policies: readonly PolicyHealth[];
}

export interface DeliveredState {
  readonly trigger: NotificationTrigger;
  // Artifact id, policy id, or "" for a fleet-wide condition.
  readonly key: string;
  readonly since: Date;
}

export interface Notification {
  readonly trigger: NotificationTrigger;
  readonly key: string;
  readonly kind: "opened" | "resolved";
  readonly summary: string;
}

export interface EvaluateInput {
  readonly snapshot: FleetSnapshot;
  // The previous evaluation, or null on the first one. The wiring only supplies it once enough time
  // has passed — the hysteresis below is meaningless if two evaluations are seconds apart.
  readonly previous: FleetSnapshot | null;
  readonly delivered: readonly DeliveredState[];
}

const isOpen = (
  delivered: readonly DeliveredState[],
  trigger: NotificationTrigger,
  key: string,
): boolean => delivered.some((d) => d.trigger === trigger && d.key === key);

export function evaluateNotifications(input: EvaluateInput): Notification[] {
  const { snapshot, previous, delivered } = input;
  const out: Notification[] = [];

  // 1. Proven bad. The only trigger that fires on a single observation, because it is not a count
  //    moving — a restore ran and the artifact did not come back usable.
  for (const artifactId of snapshot.failedArtifactIds) {
    if (!isOpen(delivered, "ARTIFACT_FAILED", artifactId)) {
      out.push({
        trigger: "ARTIFACT_FAILED",
        key: artifactId,
        kind: "opened",
        summary: `artifact ${artifactId} failed verification: a restore of it did not produce a usable database`,
      });
    }
  }

  // 2. Verification falling behind. Requires a previous evaluation, and requires the count NOT to
  //    have come down since: every healthy backup is briefly unobserved between finishing and its
  //    chained verify, so a count that is merely high is not a reason to shout. A falling count is
  //    verification working.
  const behindOpen = isOpen(delivered, "VERIFICATION_BEHIND", "");
  const behindHolds =
    previous !== null && snapshot.unobserved > 0 && snapshot.unobserved >= previous.unobserved;
  if (behindHolds && !behindOpen) {
    out.push({
      trigger: "VERIFICATION_BEHIND",
      key: "",
      kind: "opened",
      summary: `${snapshot.unobserved} artifacts are unobserved and the number is not coming down — verification is not keeping up with backups`,
    });
  } else if (!behindHolds && behindOpen) {
    out.push({
      trigger: "VERIFICATION_BEHIND",
      key: "",
      kind: "resolved",
      summary: `unobserved artifacts are being verified again (${snapshot.unobserved} outstanding)`,
    });
  }

  // 3. A policy gone quiet. Invisible to any failure-based alert: a job that never runs never
  //    fails. A policy that has NEVER succeeded counts as quiet — failing open there would hide the
  //    case where nothing was ever backed up at all.
  for (const policy of snapshot.policies) {
    const deadline = policy.expectedIntervalMs * 2;
    const quiet =
      policy.lastSucceededAt === null ||
      snapshot.at.getTime() - policy.lastSucceededAt.getTime() > deadline;
    const open = isOpen(delivered, "POLICY_QUIET", policy.id);
    if (quiet && !open) {
      out.push({
        trigger: "POLICY_QUIET",
        key: policy.id,
        kind: "opened",
        summary:
          policy.lastSucceededAt === null
            ? `policy "${policy.name}" has never produced a successful backup`
            : `policy "${policy.name}" has not produced a successful backup since ${policy.lastSucceededAt.toISOString()}`,
      });
    } else if (!quiet && open) {
      out.push({
        trigger: "POLICY_QUIET",
        key: policy.id,
        kind: "resolved",
        summary: `policy "${policy.name}" is producing backups again`,
      });
    }
  }

  return out;
}
