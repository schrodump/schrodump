// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { MetricTile } from "@schrodump/web";

export function JobsStrip() {
  return (
    <div className="grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
      <MetricTile label="Running now" value="2" note="of 4 workers" />
      <MetricTile label="In queue" value="14" sub="longest wait 12m" note="pending jobs" tone="caution" />
      <MetricTile label="Failed, 24h" value="3" sub="needs a look" note="process failures" tone="danger" />
      <MetricTile label="Inconclusive, 24h" value="1" sub="could not run" note="artifact unchanged" tone="quiet" />
    </div>
  );
}

export function Single() {
  return (
    <div className="max-w-[220px]">
      <MetricTile label="Destinations" value="12" note="S3-compatible buckets" />
    </div>
  );
}
