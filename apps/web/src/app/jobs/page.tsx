// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { JobStateChip } from "@/components/job-state-chip";
import { ColumnHeaders, GroupHeader, ListFooter, RuledList } from "@/components/ruled-list";
import { StateGlyph } from "@/components/status-badge";
import { DetailGrid, type Fact } from "@/components/ui/detail-grid";
import { FilterChip } from "@/components/ui/filter-chip";
import { MetricTile } from "@/components/ui/metric-tile";
import { Panel } from "@/components/ui/panel";
import { useJobs } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { JOB_KINDS, type JobKind, type JobState } from "@/lib/domain";
import {
  dayGroupOf,
  formatDate,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTime,
  timeZoneNote,
} from "@/lib/format";
import type { Job, JobList } from "@/lib/types";

// Five minutes: past it, a queue wait stops being scheduling jitter and becomes the signal that the
// workers are behind. The same threshold colours the tile, the row and the fact, so the reader
// meets one rule.
const LONG_WAIT_MS = 5 * 60 * 1000;

// The ledger's own order: what is happening now, then what needs a look, then the settled cases.
const STATE_ORDER: JobState[] = ["RUNNING", "PENDING", "FAILED", "INCONCLUSIVE", "SUCCEEDED", "CANCELLED"];
// The artifact's verdict, in the artifact's own words — the same keys the catalog's badge uses.
const STATE_KEY = {
  VERIFIED: "state.verified",
  UNOBSERVED: "state.unobserved",
  FAILED: "state.failed",
} as const;

// One column set, declared once: the headers and every row lay out on the same grid.
const ROW_GRID =
  "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1.4fr)_8.5rem_minmax(0,11rem)_minmax(0,1.2fr)_5.5rem_8rem]";

function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? null : value;
}

// A verify downgraded from FULL_RESTORE to CHECKSUM is recorded by the worker as a sentence in the
// job's reason (apps/server/src/jobs/verify.ts); the ledger reads that sentence back. A structured
// flag would be better and is a server change; until then the seam is here, in one place.
function isDowngrade(job: Job): boolean {
  return job.reason !== null && job.reason.includes("downgraded to CHECKSUM");
}

function shortCorrelation(id: string): string {
  return id.length > 18 ? `${id.slice(0, 16)}…` : id;
}

// The clock the timing column reads. It ticks only while something is live — a RUNNING elapsed
// time or a PENDING wait — because a static "ran in 1m 32s" has nothing to tick.
function useNow(live: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

export function JobRow({ job, now = new Date() }: { job: Job; now?: Date }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const started = ms(job.startedAt);
  const finished = ms(job.finishedAt);
  const scheduled = ms(job.scheduledAt);
  const nowMs = now.getTime();

  // How long it ran, how long it waited, and — for the live states — how long so far.
  const durationMs = started !== null && finished !== null ? finished - started : null;
  const waitMs = scheduled !== null && started !== null ? started - scheduled : null;
  const pendingWaitMs = job.state === "PENDING" && scheduled !== null ? nowMs - scheduled : null;
  const elapsedMs = job.state === "RUNNING" && started !== null ? nowMs - started : null;
  const longWait =
    (waitMs !== null && waitMs >= LONG_WAIT_MS) || (pendingWaitMs !== null && pendingWaitMs >= LONG_WAIT_MS);

  const timing =
    job.state === "RUNNING"
      ? elapsedMs !== null
        ? t("jobs.running", { duration: formatDuration(elapsedMs) })
        : t("job.state.RUNNING")
      : job.state === "PENDING"
        ? pendingWaitMs !== null
          ? t("jobs.waiting", { duration: formatDuration(pendingWaitMs) })
          : t("jobs.inQueue")
        : job.state === "CANCELLED" && durationMs !== null
          ? t("jobs.stoppedAfter", { duration: formatDuration(durationMs) })
          : durationMs !== null
            ? t("jobs.ranIn", { duration: formatDuration(durationMs) })
            : job.startedAt !== null
              ? t("jobs.startedRelative", { when: formatRelative(job.startedAt, now) })
              : null;
  const waitLine =
    job.state === "PENDING"
      ? longWait
        ? t("jobs.inQueueUnclaimed")
        : t("jobs.inQueue")
      : waitMs !== null && waitMs >= 1000
        ? `${t("jobs.queued", { duration: formatDuration(waitMs) })}${longWait ? ` · ${t("jobs.workersBehind")}` : ""}`
        : null;

  // Only when it adds something. A policy is very often named after the database it backs up, and
  // repeating the same word twice on one row reads as a rendering bug.
  const sub =
    job.policyId === null && job.scheduledAt === null
      ? t("jobs.manualRun")
      : job.policyName !== null && job.policyName !== job.targetName
        ? t("jobs.policy", { name: job.policyName })
        : null;

  const downgraded = isDowngrade(job);
  const why =
    job.reason === null
      ? null
      : job.state === "FAILED"
        ? { label: t("jobs.why.failed"), tone: "danger" as const }
        : job.state === "INCONCLUSIVE"
          ? { label: t("jobs.why.inconclusive"), tone: "info" as const }
          : job.state === "CANCELLED"
            ? { label: t("jobs.why.cancelled"), tone: "info" as const }
            : downgraded
              ? { label: t("jobs.why.downgraded"), tone: "warning" as const }
              : { label: t("jobs.why.reported"), tone: "info" as const };

  const artifactValue =
    job.artifact === null ? null : `${job.artifact.id.slice(0, 8)} · ${t(STATE_KEY[job.artifact.state])}`;
  const artifactTone: Fact["tone"] =
    job.artifact === null
      ? "plain"
      : job.artifact.state === "VERIFIED"
        ? "verified"
        : job.artifact.state === "UNOBSERVED"
          ? "unobserved"
          : "failed";
  const facts: Fact[] = [
    {
      label: t("jobs.fact.scheduled"),
      value: job.scheduledAt === null ? t("jobs.fact.manual") : formatDateTime(job.scheduledAt),
    },
    {
      label: t("jobs.fact.started"),
      value: job.startedAt === null ? null : `${formatDateTime(job.startedAt)} · ${formatRelative(job.startedAt, now)}`,
    },
    {
      label: t("jobs.fact.finished"),
      value:
        job.finishedAt === null ? null : `${formatDateTime(job.finishedAt)} · ${formatRelative(job.finishedAt, now)}`,
    },
    { label: t("jobs.fact.duration"), value: durationMs === null ? null : formatDuration(durationMs) },
    {
      label: t("jobs.fact.queueWait"),
      value: waitMs !== null && waitMs >= 1000 ? formatDuration(waitMs) : null,
      tone: longWait ? "caution" : "plain",
    },
    { label: t("jobs.fact.artifact"), value: artifactValue, tone: artifactTone },
    // A verify that could not run leaves the artifact exactly as it found it — the row says so,
    // in the artifact's own state, rather than letting "could not run" read as a verdict.
    {
      label: t("jobs.fact.after"),
      value:
        job.kind === "VERIFY" && job.state === "INCONCLUSIVE" && job.artifact !== null
          ? t("jobs.fact.unchanged", { state: t(STATE_KEY[job.artifact.state]) })
          : null,
      tone: artifactTone,
    },
    {
      label: t("jobs.fact.restoreScope"),
      value: job.restoreTarget === null ? null : t(`restoreTarget.${job.restoreTarget}`),
    },
    {
      label: t("jobs.fact.exit"),
      value: job.exitCode !== null && job.exitCode !== 0 ? String(job.exitCode) : null,
      tone: "danger",
    },
    { label: t("jobs.fact.correlation"), value: job.correlationId },
  ];

  const logLines = job.stderr === null ? [] : job.stderr.split("\n");
  const anchor = job.startedAt ?? job.scheduledAt ?? job.createdAt;

  function copyCorrelation(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    try {
      void navigator.clipboard.writeText(job.correlationId);
    } catch {
      // No clipboard (insecure context, permissions): the id is still on screen to select.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <details className="group border-b border-border">
      <summary
        className={cn(
          "grid cursor-pointer list-none items-start gap-x-4 gap-y-1 px-[18px] py-2.5 hover:bg-muted group-open:bg-muted [&::-webkit-details-marker]:hidden",
          ROW_GRID,
        )}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <svg
            aria-hidden="true"
            width="9"
            height="9"
            viewBox="0 0 8 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            className="mt-1.5 shrink-0 text-subtle-foreground transition-transform group-open:rotate-90"
          >
            <path d="M2.4 1 5.6 4 2.4 7" />
          </svg>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[10.5px] tracking-[0.13em] uppercase text-subtle-foreground">
                {t(`job.kind.${job.kind}`)}
              </span>
              {job.targetName !== null ? (
                <span className="truncate text-[13.5px] font-medium">{job.targetName}</span>
              ) : null}
            </div>
            {sub !== null ? <div className="mt-0.5 text-[12px] text-muted-foreground">{sub}</div> : null}
          </div>
        </div>

        <div className="order-first col-span-full flex items-center gap-3 sm:order-none sm:col-span-1 sm:block">
          <JobStateChip state={job.state} exitCode={job.exitCode} />
        </div>

        <div className="min-w-0 font-mono text-[12px]">
          {timing !== null ? (
            <div
              className={cn(
                job.state === "RUNNING"
                  ? "text-foreground"
                  : job.state === "PENDING" && longWait
                    ? "text-caution"
                    : "text-muted-foreground",
              )}
            >
              {timing}
            </div>
          ) : null}
          {waitLine !== null ? (
            <div className={cn("mt-0.5 text-[11px]", longWait ? "text-caution" : "text-subtle-foreground")}>
              {waitLine}
            </div>
          ) : null}
        </div>

        <div className="min-w-0 font-mono text-[12px]">
          {job.artifact !== null ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-subtle-foreground">→</span>
              <span className="text-muted-foreground">{job.artifact.id.slice(0, 8)}</span>
              <span
                data-artifact-state={job.artifact.state}
                className={cn(
                  "inline-flex items-center gap-1.5 text-[10.5px] tracking-[0.08em] uppercase",
                  job.artifact.state === "VERIFIED" && "text-state-verified",
                  job.artifact.state === "UNOBSERVED" && "text-state-unobserved",
                  job.artifact.state === "FAILED" && "text-state-failed",
                )}
              >
                <StateGlyph state={job.artifact.state} size={9} />
                {t(STATE_KEY[job.artifact.state])}
              </span>
            </div>
          ) : null}
          {downgraded ? (
            <span
              data-testid="job-downgraded"
              className="mt-1 inline-block rounded-sm border border-caution-border bg-caution-soft px-1.5 py-0.5 text-[10.5px] text-caution"
            >
              {t("jobs.downgraded")}
            </span>
          ) : null}
        </div>

        <div className="hidden font-mono text-[12px] text-muted-foreground tabular-nums sm:block">
          {formatTime(anchor)}
        </div>

        <div className="hidden justify-end sm:flex">
          <button
            type="button"
            title={t("jobs.copyCorrelation")}
            onClick={copyCorrelation}
            className={cn(
              "max-w-full truncate rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
              copied
                ? "border-accent-border text-accent"
                : "border-border text-subtle-foreground hover:border-border-region hover:text-foreground",
            )}
          >
            {copied ? t("jobs.copied") : shortCorrelation(job.correlationId)}
          </button>
        </div>
      </summary>

      <div className="space-y-4 bg-muted px-[18px] pt-1 pb-4 sm:pl-[2.9rem]">
        {why !== null ? (
          <Panel tone={why.tone} className="p-3.5">
            <div className="font-mono text-[10px] tracking-[0.13em] uppercase opacity-80">{why.label}</div>
            <p className="mt-1.5 text-[13px]">{job.reason}</p>
          </Panel>
        ) : null}

        <DetailGrid facts={facts} />

        {logLines.length > 0 ? (
          <details className="group/log">
            <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-sm border border-border px-2.5 py-1.5 font-mono text-[10.5px] tracking-[0.13em] uppercase text-muted-foreground hover:border-border-region hover:text-foreground [&::-webkit-details-marker]:hidden">
              <svg
                aria-hidden="true"
                width="8"
                height="8"
                viewBox="0 0 8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                className="transition-transform group-open/log:rotate-90"
              >
                <path d="M2.4 1 5.6 4 2.4 7" />
              </svg>
              <span>{t("jobs.logStderr")}</span>
              <span className="opacity-65">{t("jobs.logLines", { count: String(logLines.length) })}</span>
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-control border border-border bg-background p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {logLines.map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    line.startsWith("ERROR")
                      ? "text-destructive-text"
                      : line.startsWith("WARN")
                        ? "text-caution"
                        : "text-muted-foreground",
                  )}
                >
                  {line}
                </div>
              ))}
            </pre>
            <p className="mt-1.5 font-mono text-[10.5px] text-subtle-foreground">{t("jobs.logNote")}</p>
          </details>
        ) : null}
      </div>
    </details>
  );
}

type Group = { key: string; label: "today" | "yesterday" | null; sample: string; items: Job[] };

// Grouped by the viewer's local day of the moment the run began — or was meant to, for a job still
// waiting. Newest day first, newest run first within it, whatever order the rows arrived in.
function groupByDay(items: Job[], now: Date): Group[] {
  const groups = new Map<string, Group>();
  for (const job of items) {
    const anchor = job.startedAt ?? job.scheduledAt ?? job.createdAt;
    const day = dayGroupOf(anchor, now);
    const group = groups.get(day.key) ?? { ...day, sample: anchor, items: [] };
    group.items.push(job);
    groups.set(day.key, group);
  }
  return [...groups.values()]
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => {
        const aAt = a.startedAt ?? a.scheduledAt ?? a.createdAt;
        const bAt = b.startedAt ?? b.scheduledAt ?? b.createdAt;
        return aAt < bAt ? 1 : -1;
      }),
    }));
}

function groupLabel(group: Group, t: ReturnType<typeof useT>): string {
  return group.label === "today"
    ? t("group.today")
    : group.label === "yesterday"
      ? t("group.yesterday")
      : formatDate(group.sample);
}

function groupCountOf(t: ReturnType<typeof useT>, count: number): string {
  return count === 1 ? t("jobs.groupCount.one") : t("jobs.groupCount", { count: String(count) });
}

// Everything below the page title, given the list. Exported on its own so the tiles, chips and
// footer can be tested against a fixture without a session or a query client around them.
export function JobsLedger({ list, now }: { list: JobList; now: Date }) {
  const t = useT();
  const [stateFilter, setStateFilter] = useState<JobState | "ALL">("ALL");
  const [kindFilter, setKindFilter] = useState<JobKind | "ALL">("ALL");

  const visible = useMemo(
    () =>
      list.items.filter(
        (job) => (stateFilter === "ALL" || job.state === stateFilter) && (kindFilter === "ALL" || job.kind === kindFilter),
      ),
    [list.items, stateFilter, kindFilter],
  );
  const groups = useMemo(() => groupByDay(visible, now), [visible, now]);

  // The header reads the table, not the page: the counts and the stats came from the server.
  const oldest = ms(list.stats.oldestPendingScheduledAt);
  const longestWaitMs = oldest === null ? null : Math.max(0, now.getTime() - oldest);
  const queueHot = longestWaitMs !== null && longestWaitMs >= LONG_WAIT_MS;

  const columns = [
    { key: "job", label: t("jobs.col.job") },
    { key: "state", label: t("jobs.col.state") },
    { key: "timing", label: t("jobs.col.timing") },
    { key: "artifact", label: t("jobs.col.artifact") },
    { key: "localTime", label: t("jobs.col.localTime"), className: "hidden sm:block" },
    { key: "correlation", label: t("jobs.col.correlation"), className: "hidden text-right sm:block" },
  ];
  const filtered = stateFilter !== "ALL" || kindFilter !== "ALL";
  const filterSummary = t("jobs.filter.summary", {
    state: stateFilter === "ALL" ? t("jobs.filter.allStates") : t("jobs.filter.stateIs", { state: t(`job.state.${stateFilter}`) }),
    kind: kindFilter === "ALL" ? t("jobs.filter.allKinds") : t("jobs.filter.kindIs", { kind: t(`job.kind.${kindFilter}`) }),
  });

  return (
    <div className="mt-5 space-y-5">
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
        <MetricTile
          label={t("jobs.stat.running")}
          value={String(list.counts.byState.RUNNING)}
          note={t("jobs.stat.runningNote")}
        />
        <MetricTile
          label={t("jobs.stat.queue")}
          value={String(list.counts.byState.PENDING)}
          sub={longestWaitMs === null ? undefined : t("jobs.stat.queueLongest", { duration: formatDuration(longestWaitMs) })}
          note={t("jobs.stat.queueNote")}
          tone={queueHot ? "caution" : "plain"}
        />
        <MetricTile
          label={t("jobs.stat.failed24")}
          value={String(list.stats.failedLast24h)}
          sub={list.stats.failedLast24h > 0 ? t("jobs.stat.failedSub") : undefined}
          note={t("jobs.stat.failedNote")}
          tone={list.stats.failedLast24h > 0 ? "danger" : "plain"}
        />
        <MetricTile
          label={t("jobs.stat.inconclusive24")}
          value={String(list.stats.inconclusiveLast24h)}
          sub={list.stats.inconclusiveLast24h > 0 ? t("jobs.stat.inconclusiveSub") : undefined}
          note={t("jobs.stat.inconclusiveNote")}
          tone={list.stats.inconclusiveLast24h > 0 ? "quiet" : "plain"}
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("jobs.filter.state")}>
          <span className="mr-1 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
            {t("jobs.filter.state")}
          </span>
          <FilterChip
            label={t("jobs.filter.all")}
            count={list.total}
            active={stateFilter === "ALL"}
            onClick={() => setStateFilter("ALL")}
          />
          {STATE_ORDER.map((state) => (
            <FilterChip
              key={state}
              label={t(`job.state.${state}`)}
              count={list.counts.byState[state]}
              active={stateFilter === state}
              onClick={() => setStateFilter(state)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("jobs.filter.kind")}>
          <span className="mr-1 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
            {t("jobs.filter.kind")}
          </span>
          <FilterChip
            label={t("jobs.filter.all")}
            count={list.total}
            active={kindFilter === "ALL"}
            onClick={() => setKindFilter("ALL")}
          />
          {JOB_KINDS.map((kind) => (
            <FilterChip
              key={kind}
              label={t(`job.kind.${kind}`)}
              count={list.counts.byKind[kind]}
              active={kindFilter === kind}
              onClick={() => setKindFilter(kind)}
            />
          ))}
          <span className="ml-auto font-mono text-[10.5px] tracking-[0.04em] text-subtle-foreground">{filterSummary}</span>
        </div>
      </div>

      {list.items.length === 0 ? (
        <EmptyState message={t("jobs.empty")} />
      ) : (
        <RuledList>
          <ColumnHeaders columns={columns} gridClassName={ROW_GRID} />
          {visible.length === 0 ? (
            <EmptyState message={t("jobs.noneInFilter")} />
          ) : (
            groups.map((group) => (
              <section key={group.key} aria-label={groupLabel(group, t)}>
                <GroupHeader label={groupLabel(group, t)} count={groupCountOf(t, group.items.length)} />
                {group.items.map((job) => (
                  <JobRow key={job.id} job={job} now={now} />
                ))}
              </section>
            ))
          )}
          {filtered ? (
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-border px-[18px] py-2.5 font-mono text-[10.5px] tracking-[0.04em] text-subtle-foreground">
              <span>
                {t("jobs.filteredFooter", {
                  shown: String(visible.length),
                  page: String(list.items.length),
                  total: String(list.total),
                })}
              </span>
              <span>{t("jobs.timesIn", { zone: timeZoneNote(now) })}</span>
            </div>
          ) : (
            <ListFooter shown={list.items.length} total={list.total} note={t("jobs.timesIn", { zone: timeZoneNote(now) })} />
          )}
        </RuledList>
      )}
    </div>
  );
}

export default function JobsPage() {
  const t = useT();
  const jobs = useJobs();
  const live =
    jobs.data !== undefined && jobs.data.items.some((job) => job.state === "RUNNING" || job.state === "PENDING");
  const now = useNow(live);

  return (
    <AppShell>
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold">{t("jobs.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">{t("jobs.intro")}</p>
      </div>

      {jobs.isPending ? (
        <div className="mt-6">
          <LoadingState />
        </div>
      ) : jobs.isError ? (
        <div className="mt-6">
          <ErrorState message={jobs.error.message} onRetry={() => void jobs.refetch()} />
        </div>
      ) : (
        <JobsLedger list={jobs.data} now={now} />
      )}
    </AppShell>
  );
}
