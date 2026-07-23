// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Manifest } from "./manifest.js";

// Grandfather-Father-Son retention. Pure function: no clock of its own, `now` is injected.
export interface RetentionPolicy {
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  // Milliseconds. Nothing younger than this is ever deleted, whatever the counts say.
  minAgeBeforeDelete: number;
}

// Thrown when the resolution would delete a manifest that a kept manifest depends on.
// Deleting the full while keeping its incrementals is total data loss — we refuse to
// return such a result and surface it loudly instead.
export class RetentionOrphanError extends Error {
  readonly keptJobId: string;
  readonly missingDependencyJobId: string;

  constructor(keptJobId: string, missingDependencyJobId: string) {
    super(
      `retention would delete "${missingDependencyJobId}", a dependency of kept manifest ` +
        `"${keptJobId}"`,
    );
    this.name = "RetentionOrphanError";
    this.keptJobId = keptJobId;
    this.missingDependencyJobId = missingDependencyJobId;
  }
}

export function resolveRetention(
  manifests: Manifest[],
  policy: RetentionPolicy,
  now: Date,
): { keep: string[]; delete: string[] } {
  const sorted = [...manifests].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const keep = new Set<string>();

  for (const manifest of sorted.slice(0, Math.max(0, policy.keepLast))) {
    keep.add(manifest.jobId);
  }

  addPeriodic(sorted, policy.keepDaily, dayKey, keep);
  addPeriodic(sorted, policy.keepWeekly, isoWeekKey, keep);
  addPeriodic(sorted, policy.keepMonthly, monthKey, keep);
  addPeriodic(sorted, policy.keepYearly, yearKey, keep);

  const nowMs = now.getTime();
  for (const manifest of sorted) {
    if (nowMs - Date.parse(manifest.createdAt) < policy.minAgeBeforeDelete) {
      keep.add(manifest.jobId);
    }
  }

  const deleteIds = sorted.filter((m) => !keep.has(m.jobId)).map((m) => m.jobId);
  const deleteSet = new Set(deleteIds);

  // Invariant: a kept manifest must never depend on one scheduled for deletion.
  for (const manifest of sorted) {
    if (!keep.has(manifest.jobId)) continue;
    for (const dependency of manifest.dependsOn) {
      if (deleteSet.has(dependency)) {
        throw new RetentionOrphanError(manifest.jobId, dependency);
      }
    }
  }

  return {
    keep: sorted.filter((m) => keep.has(m.jobId)).map((m) => m.jobId),
    delete: deleteIds,
  };
}

// Keeps the newest manifest of each of the most recent `count` distinct period buckets.
// `sortedNewestFirst` must be sorted by createdAt descending.
function addPeriodic(
  sortedNewestFirst: Manifest[],
  count: number,
  keyOf: (date: Date) => string,
  keep: Set<string>,
): void {
  if (count <= 0) return;
  const seen = new Set<string>();
  for (const manifest of sortedNewestFirst) {
    const key = keyOf(new Date(manifest.createdAt));
    if (seen.has(key)) continue; // an older backup in a bucket we already covered
    if (seen.size >= count) break; // the most recent `count` buckets are filled
    seen.add(key);
    keep.add(manifest.jobId);
  }
}

// All bucket keys are computed in UTC so the result is deterministic across time zones.
function dayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
}

function yearKey(date: Date): string {
  return `${date.getUTCFullYear()}`;
}

function isoWeekKey(date: Date): string {
  const anchor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (anchor.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  anchor.setUTCDate(anchor.getUTCDate() - dayNum + 3); // move to the Thursday of this ISO week
  const isoYear = anchor.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((anchor.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${isoYear}-W${week}`;
}
