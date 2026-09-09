// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useT } from "@/i18n/provider";
import type { JobState } from "@/lib/domain";
import { cn } from "@/lib/cn";

// A process outcome, and deliberately not the artifact palette: a job that SUCCEEDED has proven
// that a process did not complain, and only the artifact's own marker speaks about whether a backup
// is good. So this is quiet ink with a square — no shape borrowed from the state markers, none of
// their colours — and the one outcome coloured is FAILED, the process that broke. The exit code
// rides along only when it is non-zero: exit 0 is the quiet normal and stays off the row.
const INK: Record<JobState, string> = {
  PENDING: "text-job-pending",
  RUNNING: "text-job-running",
  SUCCEEDED: "text-job-succeeded",
  FAILED: "text-job-failed",
  // Could not run: no verdict, artifact untouched. As quiet as PENDING — never the failed red.
  INCONCLUSIVE: "text-job-unknown",
  CANCELLED: "text-job-cancelled",
};

export function JobStateChip({ state, exitCode }: { state: JobState; exitCode?: number | null }) {
  const t = useT();
  const showExit = exitCode !== undefined && exitCode !== null && exitCode !== 0;
  return (
    <span
      data-job-state={state}
      className={cn(
        "inline-flex items-center gap-[7px] font-mono text-[11px] tracking-[0.06em] uppercase",
        INK[state],
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-[7px] shrink-0 rounded-[1.5px]",
          state === "PENDING" ? "border border-dashed border-current" : "bg-current",
          state === "RUNNING" && "animate-pulse",
        )}
      />
      {t(`job.state.${state}`)}
      {showExit ? (
        <span className="opacity-80">{t("jobs.exit", { code: String(exitCode) })}</span>
      ) : null}
    </span>
  );
}
