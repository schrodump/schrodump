// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useJobs } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { JOB_STATES } from "@/lib/domain";
import { formatDateTime, formatDuration, formatRelative } from "@/lib/format";
import type { Job, JobState } from "@/lib/types";

export function JobRow({ job }: { job: Job }) {
  const t = useT();
  // How long it ran (a finished job) and how long it waited to start (the queue latency a cron
  // deployment falling behind shows up as). Both derived from timestamps the row never used to show.
  const ranMs =
    job.startedAt !== null && job.finishedAt !== null
      ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
      : null;
  const queueWaitMs =
    job.scheduledAt !== null && job.startedAt !== null
      ? new Date(job.startedAt).getTime() - new Date(job.scheduledAt).getTime()
      : null;
  // Exit 0 is the quiet normal and stays off the row; a non-zero code is the forensic the reason
  // line often summarises but does not give.
  const showExit = job.exitCode !== null && job.exitCode !== 0;
  return (
    <div className="space-y-3 border-b border-border px-2 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium">{t(`job.kind.${job.kind}`)}</span>
          {job.targetName ? <span className="font-medium">{job.targetName}</span> : null}
          <span className="text-sm text-muted-foreground">{t(`job.state.${job.state}`)}</span>
          {/* Only when it adds something. A policy is very often named after the database it backs
              up, and repeating the same word twice on one row reads as a rendering bug. */}
          {job.policyName && job.policyName !== job.targetName ? (
            <span className="text-sm text-muted-foreground">{job.policyName}</span>
          ) : null}
          <code className="ml-auto rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {t("jobs.correlationId")}: {job.correlationId}
          </code>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
          {ranMs !== null ? (
            <span>{t("jobs.ranIn", { duration: formatDuration(ranMs) })}</span>
          ) : job.startedAt !== null ? (
            <span>{t("jobs.startedRelative", { when: formatRelative(job.startedAt) })}</span>
          ) : null}
          {queueWaitMs !== null && queueWaitMs >= 1000 ? (
            <span>{t("jobs.queued", { duration: formatDuration(queueWaitMs) })}</span>
          ) : null}
          {showExit ? (
            <span className="text-[var(--color-state-failed)]">
              {t("jobs.exit", { code: String(job.exitCode) })}
            </span>
          ) : null}
          {job.artifactId !== null ? (
            <span>{t("jobs.artifact", { id: job.artifactId.slice(0, 8) })}</span>
          ) : null}
          <span className="ml-auto">{formatDateTime(job.createdAt)}</span>
        </div>
        {job.reason ? <p className="text-sm text-muted-foreground">{job.reason}</p> : null}
        {job.stderr ? (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t("jobs.log")}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
              {job.stderr}
            </pre>
          </details>
        ) : null}
    </div>
  );
}

export default function JobsPage() {
  const t = useT();
  const jobs = useJobs();
  const [filter, setFilter] = useState<JobState | "ALL">("ALL");

  const visible = useMemo(
    () => (jobs.data?.items ?? []).filter((job) => filter === "ALL" || job.state === filter),
    [jobs.data, filter],
  );

  return (
    <AppShell>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t("jobs.title")}</h1>
        <div className="flex items-center gap-2">
          <Label htmlFor="state-filter" className="sr-only">
            {t("jobs.filterAll")}
          </Label>
          <Select
            id="state-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as JobState | "ALL")}
          >
            <option value="ALL">{t("jobs.filterAll")}</option>
            {JOB_STATES.map((state) => (
              <option key={state} value={state}>
                {t(`job.state.${state}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mt-6 border-t border-border">
        {jobs.isPending ? (
          <LoadingState />
        ) : jobs.isError ? (
          <ErrorState message={jobs.error.message} onRetry={() => void jobs.refetch()} />
        ) : visible.length === 0 ? (
          <EmptyState message={t("jobs.empty")} />
        ) : (
          visible.map((job) => <JobRow key={job.id} job={job} />)
        )}
      </div>
    </AppShell>
  );
}
