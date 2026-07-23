// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { ErrorState, EmptyState, LoadingState } from "@/components/feedback";
import { GuidedSetup } from "@/components/guided-setup";
import { StateCounters } from "@/components/state-counters";
import { Card, CardContent } from "@/components/ui/card";
import { useArtifacts, useJobs } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { countByState, type Job } from "@/lib/types";

function RecentJobs({ jobs }: { jobs: Job[] }) {
  const t = useT();
  return (
    <ul className="divide-y rounded-lg border">
      {jobs.map((job) => (
        <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
          <span className="font-medium">{t(`job.kind.${job.kind}`)}</span>
          <span className="text-muted-foreground">{t(`job.state.${job.state}`)}</span>
          <code className="ml-auto text-xs text-muted-foreground">{job.correlationId}</code>
        </li>
      ))}
    </ul>
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
          <StateCounters counts={countByState(artifacts.data)} />
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-medium">{t("dashboard.recentJobs")}</h2>
        {jobs.isPending ? (
          <Card>
            <CardContent className="pt-6">
              <LoadingState />
            </CardContent>
          </Card>
        ) : jobs.isError ? (
          <ErrorState message={jobs.error.message} onRetry={() => void jobs.refetch()} />
        ) : jobs.data.length === 0 ? (
          <EmptyState message={t("dashboard.noJobs")} />
        ) : (
          <RecentJobs jobs={jobs.data.slice(0, 10)} />
        )}
      </section>
    </AppShell>
  );
}
