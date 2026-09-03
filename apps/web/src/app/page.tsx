// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { ErrorState, EmptyState, LoadingState } from "@/components/feedback";
import { GuidedSetup } from "@/components/guided-setup";
import { StateCounters } from "@/components/state-counters";
import { useArtifacts, useJobs } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import type { Job } from "@/lib/types";

// Exported so the row can be asserted directly, like ArtifactRow.
//
// This list used to show kind, state and the correlationId — an opaque internal string — and drop
// `reason`, which is the field that says what actually happened. On a running deployment those
// reasons read "verify level NONE — artifact remains UNOBSERVED" and "a DATABASE restore of this
// mariadb artifact cannot be confined…". Neither reached the screen; a sixty-character id sat
// where the explanation belonged. The id still exists, on the jobs screen, where someone is
// chasing one job rather than scanning ten.
export function RecentJobs({ jobs }: { jobs: Job[] }) {
  const t = useT();
  return (
    <div className="border-t border-border">
      {jobs.map((job) => {
        const failed = job.state === "FAILED";
        return (
          <div
            key={job.id}
            className="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-4 gap-y-0.5 border-b border-border px-2 py-2 sm:grid-cols-[5.5rem_6.5rem_1fr_auto]"
          >
            <span className="font-mono text-xs tracking-[0.06em] text-muted-foreground">
              {t(`job.kind.${job.kind}`)}
            </span>
            {/* Job state deliberately does NOT borrow the artifact state palette. A job that
                succeeded has proven a process did not complain; only the artifact chip speaks
                about whether a backup is good. Failure is the one job outcome worth colouring. */}
            <span
              data-testid={`job-state-${job.id}`}
              data-failed={failed ? "true" : "false"}
              className={
                failed
                  ? "hidden font-mono text-xs font-semibold tracking-[0.06em] text-[var(--color-state-failed)] sm:block"
                  : "hidden font-mono text-xs font-semibold tracking-[0.06em] text-[var(--color-foreground-soft)] sm:block"
              }
            >
              {t(`job.state.${job.state}`)}
            </span>
            <span className="min-w-0 text-sm text-[var(--color-foreground-soft)]">
              {job.reason}
            </span>
            <span className="hidden font-mono text-xs text-muted-foreground sm:block">
              {(job.finishedAt ?? job.createdAt).slice(11, 16)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function DashboardPage() {
  const t = useT();
  const artifacts = useArtifacts();
  const jobs = useJobs();

  return (
    <AppShell>
      <h1 className="mb-6 text-2xl font-semibold">{t("dashboard.title")}</h1>

      <GuidedSetup />

      <section>
        {artifacts.isPending ? (
          <LoadingState />
        ) : artifacts.isError ? (
          <ErrorState message={artifacts.error.message} onRetry={() => void artifacts.refetch()} />
        ) : (
          // Straight from the server: computed over the whole table, not the returned page.
          <StateCounters counts={artifacts.data.counts} />
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-medium">{t("dashboard.recentJobs")}</h2>
        {jobs.isPending ? (
          <LoadingState />
        ) : jobs.isError ? (
          <ErrorState message={jobs.error.message} onRetry={() => void jobs.refetch()} />
        ) : jobs.data.items.length === 0 ? (
          <EmptyState message={t("dashboard.noJobs")} />
        ) : (
          <RecentJobs jobs={jobs.data.items.slice(0, 10)} />
        )}
      </section>
    </AppShell>
  );
}
