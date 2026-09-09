// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { JobStateChip } from "@schrodump/web";

export function ProcessOutcomes() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <JobStateChip state="PENDING" />
      <JobStateChip state="RUNNING" />
      <JobStateChip state="SUCCEEDED" />
      <JobStateChip state="FAILED" />
      <JobStateChip state="INCONCLUSIVE" />
      <JobStateChip state="CANCELLED" />
    </div>
  );
}

export function WithExitCode() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <JobStateChip state="FAILED" exitCode={1} />
      <JobStateChip state="FAILED" exitCode={137} />
      <JobStateChip state="SUCCEEDED" exitCode={0} />
    </div>
  );
}
