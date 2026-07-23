// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useJobs } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { JOB_STATES } from "@/lib/domain";
import type { Job, JobState } from "@/lib/types";

function JobRow({ job }: { job: Job }) {
  const t = useT();
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium">{t(`job.kind.${job.kind}`)}</span>
          <span className="text-sm text-muted-foreground">{t(`job.state.${job.state}`)}</span>
          <code className="ml-auto rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {t("jobs.correlationId")}: {job.correlationId}
          </code>
        </div>
        {job.reason ? <p className="text-sm text-muted-foreground">{job.reason}</p> : null}
        {job.stderr ? (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">{t("jobs.log")}</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
              {job.stderr}
            </pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function JobsPage() {
  const t = useT();
  const jobs = useJobs();
  const [filter, setFilter] = useState<JobState | "ALL">("ALL");

  const visible = useMemo(
    () => (jobs.data ?? []).filter((job) => filter === "ALL" || job.state === filter),
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

      <div className="mt-6 space-y-3">
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
