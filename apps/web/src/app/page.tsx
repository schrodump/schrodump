// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { GuidedSetup } from "@/components/guided-setup";
import { JobStateChip } from "@/components/job-state-chip";
import { ColumnHeaders, RuledList } from "@/components/ruled-list";
import { StateCounters } from "@/components/state-counters";
import { useArtifacts, useJobs } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import type { Job } from "@/lib/types";

const ROW_GRID = "grid-cols-[5.5rem_minmax(0,1fr)] sm:grid-cols-[5.5rem_9rem_minmax(0,1fr)_4.5rem]";

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
    <div>
      {jobs.map((job) => {
        const failed = job.state === "FAILED";
        return (
          <div key={job.id} className={cn("grid items-baseline gap-x-4 gap-y-0.5 border-b border-border px-[18px] py-2 last:border-b-0", ROW_GRID)}>
            <span className="font-mono text-[10.5px] tracking-[0.13em] uppercase text-subtle-foreground">{t(`job.kind.${job.kind}`)}</span>
            {/* Job state deliberately does NOT borrow the artifact state palette. A job that
                succeeded has proven a process did not complain; only the artifact chip speaks
                about whether a backup is good. Failure is the one job outcome worth colouring. */}
            <span data-testid={`job-state-${job.id}`} data-failed={failed ? "true" : "false"} className="hidden sm:block">
              <JobStateChip state={job.state} exitCode={job.exitCode} />
            </span>
            <span className="min-w-0 text-[13px] text-muted-foreground">{job.reason}</span>
            {/* The viewer's zone, never a slice of the ISO string: `.slice(11, 16)` printed UTC, so
                a São Paulo operator read a 02:00 job as 05:00 — the quiet mismatch that makes a
                person distrust the whole screen. Same rule as every other timestamp in the app. */}
            <span className="hidden font-mono text-[11.5px] text-subtle-foreground tabular-nums sm:block">
              {formatTime(job.finishedAt ?? job.createdAt)}
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

  const columns = [
    { key: "kind", label: t("dashboard.col.kind") },
    { key: "state", label: t("dashboard.col.state"), className: "hidden sm:block" },
    { key: "what", label: t("dashboard.col.what") },
    { key: "local", label: t("dashboard.col.local"), className: "hidden sm:block" },
  ];

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
          <StateCounters counts={artifacts.data.counts} total={artifacts.data.total} verifiedByLevel={artifacts.data.verifiedByLevel} />
        )}
      </section>

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-medium">{t("dashboard.recentJobs")}</h2>
          <Link href="/jobs" className="font-mono text-[10.5px] tracking-[0.13em] uppercase text-accent hover:underline">
            {t("dashboard.fullLedger")}
          </Link>
        </div>
        {jobs.isPending ? (
          <LoadingState />
        ) : jobs.isError ? (
          <ErrorState message={jobs.error.message} onRetry={() => void jobs.refetch()} />
        ) : jobs.data.items.length === 0 ? (
          <EmptyState message={t("dashboard.noJobs")} />
        ) : (
          <RuledList>
            <ColumnHeaders columns={columns} gridClassName={ROW_GRID} />
            <RecentJobs jobs={jobs.data.items.slice(0, 10)} />
          </RuledList>
        )}
      </section>
    </AppShell>
  );
}
