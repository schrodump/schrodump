// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { ColumnHeaders, GroupHeader, ListFooter } from "@/components/ruled-list";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useAuditLog } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { dayGroupOf, formatDate, formatTime, timeZoneNote } from "@/lib/format";
import type { AuditEntry, AuditList } from "@/lib/types";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1fr)_4.5rem_6.5rem]";

// The trail the server has kept since the first migration and never showed: who did what, when.
// Exported so a row can be asserted directly.
export function AuditRow({ entry }: { entry: AuditEntry }) {
  const t = useT();
  return (
    <div className={cn("grid items-baseline gap-x-4 gap-y-1 border-b border-border px-2 py-2", ROW_GRID)}>
      <span className="truncate font-mono text-[12.5px] font-medium">{entry.action}</span>
      {/* A null actor is a job's own credential read, attributed by correlation, not a person —
          "system", never a blank that reads as missing data. */}
      <span className={cn("truncate text-[12.5px]", entry.actorEmail === null ? "text-subtle-foreground" : "font-mono text-muted-foreground")}>
        {entry.actorEmail ?? t("audit.system")}
      </span>
      <span className="truncate font-mono text-[11.5px] text-muted-foreground">
        {entry.targetType !== null ? `${entry.targetType}${entry.targetId !== null ? `:${entry.targetId.slice(0, 8)}` : ""}` : ""}
      </span>
      <span className="hidden font-mono text-[11.5px] text-subtle-foreground tabular-nums sm:block">{formatTime(entry.createdAt)}</span>
      <code className="hidden truncate rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-subtle-foreground sm:block">
        {entry.correlationId}
      </code>
    </div>
  );
}

type Group = { key: string; label: "today" | "yesterday" | null; sample: string; items: AuditEntry[] };

function groupByDay(items: AuditEntry[], now: Date): Group[] {
  const groups = new Map<string, Group>();
  for (const entry of items) {
    const day = dayGroupOf(entry.createdAt, now);
    const group = groups.get(day.key) ?? { ...day, sample: entry.createdAt, items: [] };
    group.items.push(entry);
    groups.set(day.key, group);
  }
  return [...groups.values()]
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    .map((group) => ({ ...group, items: [...group.items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) }));
}

// Everything below the title, given the list. Exported on its own so the filters, the groups and
// the footer can be tested against a fixture without a session or a query client around them.
export function AuditLedger({ list, now = new Date() }: { list: AuditList; now?: Date }) {
  const t = useT();
  const [action, setAction] = useState("all");
  const [actor, setActor] = useState("all");

  const actions = useMemo(() => [...new Set(list.items.map((entry) => entry.action))].sort(), [list.items]);
  const actors = useMemo(
    () => [...new Set(list.items.map((entry) => entry.actorEmail).filter((email): email is string => email !== null))].sort(),
    [list.items],
  );
  const visible = useMemo(
    () =>
      list.items.filter(
        (entry) =>
          (action === "all" || entry.action === action) &&
          (actor === "all" || (actor === "system" ? entry.actorEmail === null : entry.actorEmail === actor)),
      ),
    [list.items, action, actor],
  );
  const groups = useMemo(() => groupByDay(visible, now), [visible, now]);
  const filtered = action !== "all" || actor !== "all";

  const columns = [
    { key: "action", label: t("audit.col.action") },
    { key: "actor", label: t("audit.col.actor") },
    { key: "subject", label: t("audit.col.subject") },
    { key: "local", label: t("audit.col.local"), className: "hidden sm:block" },
    { key: "correlation", label: t("audit.col.correlation"), className: "hidden sm:block" },
  ];

  return (
    <div className="mt-5 space-y-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">{t("audit.filter.action")}</span>
          <Select className="h-8 w-56 text-[12.5px]" value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="all">{t("audit.filter.everyAction")}</option>
            {actions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">{t("audit.filter.actor")}</span>
          <Select className="h-8 w-64 text-[12.5px]" value={actor} onChange={(event) => setActor(event.target.value)}>
            <option value="all">{t("audit.filter.everyActor")}</option>
            <option value="system">{t("audit.system")}</option>
            {actors.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {list.items.length === 0 ? (
        <EmptyState message={t("audit.empty")} />
      ) : (
        <div>
          <ColumnHeaders columns={columns} gridClassName={ROW_GRID} />
          {visible.length === 0 ? (
            <EmptyState message={t("audit.noneInFilter")} />
          ) : (
            groups.map((group) => (
              <section key={group.key} aria-label={groupLabel(group, t)}>
                <GroupHeader
                  label={groupLabel(group, t)}
                  count={group.items.length === 1 ? t("audit.groupCount.one") : t("audit.groupCount", { count: String(group.items.length) })}
                />
                {group.items.map((entry) => (
                  <AuditRow key={entry.id} entry={entry} />
                ))}
              </section>
            ))
          )}
          {filtered ? (
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-2 pt-3 font-mono text-[10.5px] tracking-[0.04em] text-subtle-foreground">
              <span>
                {t("audit.filteredFooter", { shown: String(visible.length), page: String(list.items.length), total: String(list.total) })}
              </span>
              <span>{t("jobs.timesIn", { zone: timeZoneNote(now) })}</span>
            </div>
          ) : (
            <ListFooter shown={list.items.length} total={list.total} note={t("jobs.timesIn", { zone: timeZoneNote(now) })} />
          )}
        </div>
      )}
    </div>
  );
}

function groupLabel(group: Group, t: ReturnType<typeof useT>): string {
  return group.label === "today" ? t("group.today") : group.label === "yesterday" ? t("group.yesterday") : formatDate(group.sample);
}

export default function AuditPage() {
  const t = useT();
  const role = useCurrentRole();
  const audit = useAuditLog();

  return (
    <AppShell>
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold">{t("audit.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">{t("audit.description")}</p>
      </div>

      {/* The nav hides the link for other roles; reaching the route directly lands on this
          sentence rather than on an empty page. The server's 403 is the lock; this is the sign. */}
      {role !== "admin" ? (
        <Panel tone="lock" className="mt-5 p-3.5">
          <p className="text-[12.5px] text-muted-foreground text-pretty">{t("audit.viewerLocked")}</p>
        </Panel>
      ) : audit.isPending ? (
        <div className="mt-6">
          <LoadingState />
        </div>
      ) : audit.isError ? (
        <div className="mt-6">
          <ErrorState message={audit.error.message} onRetry={() => void audit.refetch()} />
        </div>
      ) : (
        <AuditLedger list={audit.data} />
      )}
    </AppShell>
  );
}
