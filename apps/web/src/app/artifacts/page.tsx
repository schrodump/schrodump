// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { DeleteArtifactButton } from "@/components/delete-artifact-dialog";
import { RestoreButton } from "@/components/restore-dialog";
import { ColumnHeaders, GroupHeader, ListFooter, RuledList } from "@/components/ruled-list";
import { StatusBadge } from "@/components/status-badge";
import { StateCounters } from "@/components/state-counters";
import { VerifyLevelChip } from "@/components/verify-level-chip";
import { Button } from "@/components/ui/button";
import { DetailGrid, type Fact } from "@/components/ui/detail-grid";
import { FilterChip } from "@/components/ui/filter-chip";
import { ProportionBar } from "@/components/ui/proportion-bar";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useTriggerVerify } from "@/hooks/use-mutations";
import { useArtifacts, useDestinations } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import type { ArtifactState, Role } from "@/lib/domain";
import {
  dayGroupOf,
  formatBytes,
  formatDate,
  formatDateTime,
  formatRelative,
  formatServerVersion,
} from "@/lib/format";
import type { Artifact } from "@/lib/types";

// One grid for the header row and every summary row, so the columns line up without a table:
// state · verify level · what it is · size · age · actions. The middle column is the only one that
// flexes and truncates; the state and the actions never get squeezed.
const ROW_GRID =
  "grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[10.5rem_8.5rem_minmax(0,1fr)_5.5rem_6rem_auto]";

// Exported so the row can be asserted directly. The page around it needs the resource hooks; the
// question this component answers — what does the operator actually SEE about an artifact — does
// not, and it is the question that matters.
//
// Two tiers, because there are nineteen fields and an operator arrives with one question. The
// summary line carries the scan: state, how the verdict was earned, what the artifact is, size,
// age. Everything forensic — the bucket key, the checksum, which recipients it was sealed to —
// opens in place.
//
// A native <details>, not a script-driven panel: it is keyboard-operable and screen-reader
// announced for free, it survives with JavaScript still loading, and the content stays in the
// document so nothing is a route away. The headline is the state and what the artifact IS — the
// target it was taken from — never the sixty-character storage path it used to lead with.
export function ArtifactRow({
  artifact,
  role,
  destinationName,
}: {
  artifact: Artifact;
  role: Role;
  // Resolved by the page from the destinations list; null when it cannot be resolved (a destination
  // that was deleted), where the raw id is shown rather than an empty cell.
  destinationName: string | null;
}) {
  const t = useT();
  const verify = useTriggerVerify();
  // How many times smaller the stored object is than the logical dump — a health signal at a
  // glance (a backup that "compressed" 1.0x is usually a backup of nothing). Guarded against a
  // zero/absent compressed size.
  const ratio =
    artifact.sizeCompressedBytes > 0 ? artifact.sizeRawBytes / artifact.sizeCompressedBytes : null;
  const engineLine = `${t(`engine.${artifact.engine}`)} / ${t(`executionMode.${artifact.executionMode}`)}`;
  const verified = artifact.state === "VERIFIED";

  const facts: Fact[] = [
    { label: t("artifacts.detail.destination"), value: destinationName ?? artifact.destinationId },
    { label: t("artifacts.detail.created"), value: formatDateTime(artifact.createdAt) },
    {
      label: t("artifacts.detail.lastVerified"),
      value: artifact.verifiedLevel !== null ? formatRelative(artifact.updatedAt) : null,
      tone: verified ? "verified" : "plain",
    },
    { label: t("artifacts.detail.bucketKey"), value: artifact.bucketKey },
    {
      label: t("artifacts.detail.checksum"),
      value: `${artifact.checksumAlgorithm} · ${artifact.checksum}`,
    },
    {
      label: t("artifacts.detail.ratio"),
      value:
        ratio === null
          ? null
          : `${ratio.toFixed(1)}× (${formatBytes(artifact.sizeRawBytes)} → ${formatBytes(artifact.sizeCompressedBytes)})`,
    },
    { label: t("artifacts.detail.compression"), value: artifact.compression },
    { label: t("artifacts.detail.server"), value: formatServerVersion(artifact.serverVersionNum) },
    { label: t("artifacts.detail.sealedTo"), value: artifact.keyIds.join(" · ") },
    {
      label: t("artifacts.detail.verifiedVia"),
      value:
        artifact.verifiedLevel !== null
          ? `${t(`verifyLevel.${artifact.verifiedLevel}`)}${artifact.verifiedDegraded ? ` — ${t("artifacts.downgradedReason")}` : ""}`
          : null,
      tone: artifact.verifiedDegraded ? "caution" : "plain",
    },
    // Only when recorded: null is "not tracked for this engine" (see the API mapper), and printing
    // "no" for it would assert something the dump never said.
    {
      label: t("artifacts.detail.multiDatabase"),
      value:
        artifact.dumpIsMultiDatabase === null
          ? null
          : artifact.dumpIsMultiDatabase
            ? t("common.yes")
            : t("common.no"),
    },
    {
      label: t("artifacts.detail.dependsOn"),
      value: artifact.dependsOn.length > 0 ? artifact.dependsOn.map((id) => id.slice(0, 8)).join(" · ") : null,
    },
    // Only when true: an archive WITH an oplog restores to a single instant. `false` (a mongo dump
    // carrying none) and `null` (an engine that has no such thing) both stay silent.
    {
      label: t("artifacts.detail.provenance"),
      value: artifact.sourceHasOplog === true ? t("artifacts.oplog") : null,
    },
  ];

  return (
    <details className="group border-b border-border">
      <summary
        className={cn(
          "grid cursor-pointer list-none items-center gap-x-4 gap-y-1 px-[18px] py-2.5 hover:bg-muted [&::-webkit-details-marker]:hidden",
          ROW_GRID,
        )}
      >
        <span className="flex items-center gap-2 justify-self-start">
          <span
            aria-hidden="true"
            className="font-mono text-[10px] text-subtle-foreground transition-transform group-open:rotate-90"
          >
            ›
          </span>
          {/* justify-self, because a grid child stretches to its track by default and the chip
              would paint its background across the whole column — the badge hugs its own word. */}
          <StatusBadge state={artifact.state} />
        </span>
        <span className="hidden justify-self-start sm:block">
          <VerifyLevelChip
            level={artifact.verifiedLevel}
            degraded={artifact.verifiedDegraded}
            state={artifact.state}
          />
        </span>
        <span className="min-w-0">
          {artifact.targetName !== null ? (
            <span className="block truncate text-sm font-medium">{artifact.targetName}</span>
          ) : null}
          <span
            className={cn(
              "block truncate font-mono text-xs",
              artifact.targetName !== null ? "text-muted-foreground" : "text-sm text-foreground",
            )}
          >
            {engineLine}
          </span>
        </span>
        <span className="hidden text-right font-mono text-xs tabular-nums text-muted-foreground sm:block">
          {formatBytes(artifact.sizeCompressedBytes)}
        </span>
        <span className="hidden font-mono text-xs text-subtle-foreground sm:block">
          {formatRelative(artifact.createdAt)}
        </span>
        <span className="flex justify-end gap-2">
          <Button
            size="sm"
            variant={verified ? "quiet" : "accent"}
            onClick={(event) => {
              // The actions live inside the summary so they are reachable without opening the row.
              // Stopping the default keeps a click on them from toggling the disclosure underneath.
              event.preventDefault();
              verify.mutate(artifact.id);
            }}
            disabled={verify.isPending}
          >
            {verify.isPending
              ? t("common.loading")
              : verified
                ? t("artifacts.reverify")
                : t("artifacts.verify")}
          </Button>
          <span onClick={(event) => event.preventDefault()}>
            <RestoreButton artifact={artifact} role={role} />
          </span>
          <span onClick={(event) => event.preventDefault()}>
            <DeleteArtifactButton artifact={artifact} role={role} />
          </span>
        </span>
      </summary>

      <div className="bg-muted px-[18px] pt-2 pb-4 sm:pl-12">
        <DetailGrid facts={facts} />
      </div>
    </details>
  );
}

// Newest first, as the server sends them, folded into their local days. The map keeps insertion
// order, so the groups come out newest first too.
function groupByDay(items: Artifact[], now: Date): { key: string; label: "today" | "yesterday" | null; sample: string; items: Artifact[] }[] {
  const groups = new Map<string, { key: string; label: "today" | "yesterday" | null; sample: string; items: Artifact[] }>();
  for (const artifact of items) {
    const day = dayGroupOf(artifact.createdAt, now);
    const group = groups.get(day.key) ?? { ...day, sample: artifact.createdAt, items: [] };
    group.items.push(artifact);
    groups.set(day.key, group);
  }
  // Newest day first, newest artifact first within it — whatever order the items arrived in. The
  // key is a local YYYY-MM-DD, so string order is date order.
  return [...groups.values()]
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    }));
}

// The catalog has no plural rules beyond one-versus-many, so the singular gets its own key rather
// than a "1 artifacts" that reads as a bug.
function summaryOf(
  t: ReturnType<typeof useT>,
  data: { total: number; destinations: number; counts: { UNOBSERVED: number } },
): string {
  const pct = data.total > 0 ? ((data.counts.UNOBSERVED / data.total) * 100).toFixed(1) : "0.0";
  const destinations =
    data.destinations === 1
      ? t("artifacts.destinations.one")
      : t("artifacts.destinations", { count: data.destinations.toLocaleString() });
  return data.total === 1
    ? t("artifacts.summary.one", { destinations, pct })
    : t("artifacts.summary", { total: data.total.toLocaleString(), destinations, pct });
}

function groupCountOf(t: ReturnType<typeof useT>, count: number): string {
  return count === 1 ? t("artifacts.groupCount.one") : t("artifacts.groupCount", { count: String(count) });
}

// The open question leads, in the filters as in the counters.
const FILTER_ORDER: ArtifactState[] = ["UNOBSERVED", "VERIFIED", "FAILED"];

const STATE_FILL: Record<ArtifactState, string> = {
  UNOBSERVED: "bg-state-unobserved",
  VERIFIED: "bg-state-verified",
  FAILED: "bg-state-failed",
};

export default function ArtifactsPage() {
  const t = useT();
  const artifacts = useArtifacts();
  const destinations = useDestinations();
  const role = useCurrentRole();
  const [filter, setFilter] = useState<ArtifactState | "ALL">("ALL");

  // id -> name, so a row shows "Cloudflare R2" rather than a cuid. Resolved here (the page holds
  // the destinations query) and passed down, keeping ArtifactRow a pure function of its props.
  const destinationName = new Map((destinations.data ?? []).map((d) => [d.id, d.name]));
  const data = artifacts.data;
  const visible = useMemo(
    () => (data?.items ?? []).filter((artifact) => filter === "ALL" || artifact.state === filter),
    [data, filter],
  );
  const groups = useMemo(() => groupByDay(visible, new Date()), [visible]);
  const columns = [
    { key: "state", label: t("artifacts.col.state") },
    { key: "level", label: t("artifacts.col.verifyLevel") },
    { key: "artifact", label: t("artifacts.col.artifact") },
    { key: "size", label: t("artifacts.col.size"), className: "text-right" },
    { key: "age", label: t("artifacts.col.age") },
    { key: "actions", label: t("artifacts.col.actions"), className: "text-right" },
  ];

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">{t("artifacts.title")}</h1>

      {data !== undefined ? (
        <div className="mt-5 space-y-3 [&>*:first-child]:mb-6">
          {/* The catalog leads with the same figure the dashboard does, in the catalog's own words,
              and names the oldest open question under it — the artifact that has waited longest
              for anyone to look. All of it from the server's counts over the whole table. */}
          <StateCounters
            counts={data.counts}
            total={data.total}
            verifiedByLevel={data.verifiedByLevel}
            caption={t("artifacts.caption")}
            hint={t("artifacts.hint")}
            facts={
              data.oldestUnobserved !== null ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] tracking-[0.13em] uppercase text-subtle-foreground">
                  <span>{t("artifacts.oldestUnverified")}</span>
                  <span className="rounded-sm border border-state-unobserved-border bg-state-unobserved-soft px-2 py-0.5 tracking-[0.04em] normal-case text-state-unobserved">
                    {t("artifacts.oldestValue", {
                      age: formatRelative(data.oldestUnobserved.createdAt),
                      target: data.oldestUnobserved.targetName ?? data.oldestUnobserved.id.slice(0, 8),
                      mode: t(`executionMode.${data.oldestUnobserved.executionMode}`),
                    })}
                  </span>
                </div>
              ) : undefined
            }
          />
          {/* The fleet's shape as a bar: the share that is still a question leads, because it is
              the number that matters. */}
          <ProportionBar
            label={summaryOf(t, data)}
            parts={[
              { key: "UNOBSERVED", value: data.counts.UNOBSERVED, className: STATE_FILL.UNOBSERVED },
              { key: "VERIFIED", value: data.counts.VERIFIED, className: STATE_FILL.VERIFIED },
              { key: "FAILED", value: data.counts.FAILED, className: STATE_FILL.FAILED },
            ]}
          />
          <p className="font-mono text-[10.5px] tracking-[0.04em] text-subtle-foreground">
            {summaryOf(t, data)}
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("artifacts.col.state")}>
            <FilterChip
              label={t("artifacts.all")}
              count={data.total}
              active={filter === "ALL"}
              onClick={() => setFilter("ALL")}
            />
            {FILTER_ORDER.map((state) => (
              <FilterChip
                key={state}
                label={t(`state.${state.toLowerCase() as "verified" | "unobserved" | "failed"}`)}
                count={data.counts[state]}
                active={filter === state}
                state={state}
                onClick={() => setFilter(state)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-6">
        {artifacts.isPending ? (
          <LoadingState />
        ) : artifacts.isError ? (
          <ErrorState message={artifacts.error.message} onRetry={() => void artifacts.refetch()} />
        ) : data === undefined || data.items.length === 0 ? (
          <EmptyState message={t("artifacts.empty")} />
        ) : visible.length === 0 ? (
          <EmptyState message={t("artifacts.noneInFilter")} />
        ) : (
          <>
            {/* One card holding a ruled list, not a stack of cards: forty equally-boxed objects
                ask the eye to separate what the content already separates. */}
            <RuledList>
              <div className="hidden sm:block">
                <ColumnHeaders columns={columns} gridClassName={ROW_GRID} />
              </div>
              {groups.map((group) => (
                <section key={group.key} aria-label={groupLabel(group, t)}>
                  <GroupHeader
                    label={groupLabel(group, t)}
                    count={groupCountOf(t, group.items.length)}
                  />
                  {group.items.map((artifact) => (
                    <ArtifactRow
                      key={artifact.id}
                      artifact={artifact}
                      role={role}
                      destinationName={destinationName.get(artifact.destinationId) ?? null}
                    />
                  ))}
                </section>
              ))}
              <ListFooter shown={data.items.length} total={data.total} note={t("list.countsNote")} />
            </RuledList>
          </>
        )}
      </div>
    </AppShell>
  );
}

function groupLabel(
  group: { label: "today" | "yesterday" | null; sample: string },
  t: ReturnType<typeof useT>,
): string {
  if (group.label === "today") return t("group.today");
  if (group.label === "yesterday") return t("group.yesterday");
  return formatDate(group.sample);
}
