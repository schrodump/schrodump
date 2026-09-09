// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { LastCheck } from "@/components/last-check";
import { ColumnHeaders, RuledList } from "@/components/ruled-list";
import { TargetForm } from "@/components/target-form";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { VerdictPanel } from "@/components/verdict-panel";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useDeleteTarget, useTestConnection } from "@/hooks/use-mutations";
import { usePolicies, useTargets } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { canManageTargets, type ProbeFailureCode, type Role } from "@/lib/domain";
import type { Policy, Target } from "@/lib/types";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_12rem_auto]";

// One row per target: what it is, what it backs up, what the last probe recorded, and the three
// actions. Everything a probe or a delete comes back with renders UNDER the row, full width, so a
// verdict is read beside the target it is about and never in a toast that vanishes. The role is
// the second lock: a viewer sees no actions, and the server refuses the calls regardless.
export function TargetRow({
  target,
  role = "viewer",
  policies = [],
  onEdit,
}: {
  target: Target;
  role?: Role;
  policies?: Policy[];
  onEdit?: () => void;
}) {
  const t = useT();
  const test = useTestConnection();
  const remove = useDeleteTarget();
  const [confirming, setConfirming] = useState(false);
  const manage = canManageTargets(role);

  // What the target actually backs up. Empty across all three is a whole-instance dump (a mongo
  // replica set, an unscoped mysql), NOT "unknown" — so it says so rather than leaving a blank.
  const scopeNames = [...target.scope.databases, ...target.scope.schemas, ...target.scope.collections];
  const whole = scopeNames.length === 0;
  const scopeText = whole ? t("targets.scope.wholeInstance") : scopeNames.join(", ");
  const users = policies.filter((policy) => policy.targetId === target.id);
  const hostPort = `${target.host}:${target.port}`;

  return (
    <div className="border-b border-border">
      <div className={cn("grid items-start gap-x-4 gap-y-2 px-[18px] py-3", ROW_GRID)}>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium">{target.name}</div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
            {t(`engine.${target.engine}`)} · {hostPort}
          </div>
          {users.length > 0 ? (
            <div className="mt-0.5 truncate font-mono text-[11px] text-subtle-foreground">
              {t("targets.list.usedBy", { names: users.map((policy) => policy.name).join(", ") })}
            </div>
          ) : null}
        </div>

        <div className="min-w-0 font-mono text-[12px]">
          <div className="break-words">{t("targets.scopeLine", { scope: scopeText })}</div>
          {whole && target.engine === "mongodb" ? (
            <div className="mt-0.5 text-[11px] text-subtle-foreground">{t("targets.list.replicaNote")}</div>
          ) : null}
        </div>

        <div className="min-w-0">
          {/* The recorded probe: never-run is amber, not a grey dash — it is an open question, and a
              dash reads as "not applicable". A failure says WHY, as a code and a sentence; never
              the driver's message, which embeds the credential. */}
          <LastCheck
            ok={target.lastProbeOk}
            at={target.lastProbeAt}
            keys={{ never: "targets.probe.never", lastOk: "targets.probe.lastOk", lastFailed: "targets.probe.lastFailed" }}
          />
          {target.lastProbeOk === false && target.lastProbeFailure !== null ? (
            <div className="mt-1 text-[12px] text-state-failed">
              <span className="font-mono text-[10.5px] tracking-[0.08em] uppercase">{target.lastProbeFailure}</span>
              <span className="ml-1.5">{t(`targets.probe.reason.${target.lastProbeFailure as ProbeFailureCode}`)}</span>
            </div>
          ) : null}
        </div>

        {manage ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button size="sm" variant="quiet" onClick={() => test.mutate(target.id)} disabled={test.isPending}>
              {test.isPending ? t("common.loading") : t("targets.testConnection")}
            </Button>
            {onEdit !== undefined ? (
              <Button size="sm" variant="quiet" onClick={onEdit}>
                {t("common.edit")}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} disabled={confirming}>
              {t("common.delete")}
            </Button>
          </div>
        ) : null}
      </div>

      {test.isPending ? (
        <p className="px-[18px] pb-3 font-mono text-[11px] text-subtle-foreground">
          {t("targets.test.dialling", { host: hostPort })}
        </p>
      ) : null}
      {test.isSuccess ? (
        <div className="px-[18px] pb-3">
          <VerdictPanel result={test.data} hostPort={hostPort} user={target.username} tls={target.tls} />
        </div>
      ) : null}
      {test.isError ? (
        <div className="px-[18px] pb-3">
          <ErrorState message={test.error.message} />
        </div>
      ) : null}

      {confirming ? (
        <div className="px-[18px] pb-3">
          {/* The server refuses a delete while a policy points here; the row says so before the
              click rather than after the 409, and the button carries the reason. */}
          <Panel tone="danger" className="flex flex-wrap items-center gap-3 p-3.5">
            <span className="min-w-0 flex-1 text-[12.5px]">
              {users.length === 0
                ? t("targets.delete.confirm")
                : users.length === 1
                  ? t("targets.delete.inUse.one")
                  : t("targets.delete.inUse", { count: String(users.length) })}
            </span>
            <Button type="button" size="sm" variant="quiet" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              onClick={() => remove.mutate(target.id)}
              disabled={remove.isPending}
              disabledReason={remove.isPending || users.length === 0 ? null : t("targets.delete.blocked")}
            >
              {remove.isPending ? t("common.loading") : t("targets.delete.submit")}
            </Button>
          </Panel>
          {/* The server's 409 names what still depends on the row. Showing it verbatim is the
              point — "in use" on its own is not actionable. */}
          {remove.isError ? (
            <div className="mt-2">
              <ErrorState message={`${t("targets.delete.refused")} — ${remove.error.message}`} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function TargetsPage() {
  const t = useT();
  const role = useCurrentRole();
  const targets = useTargets();
  const policies = usePolicies();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const manage = canManageTargets(role);

  const columns = [
    { key: "target", label: t("targets.col.target") },
    { key: "scope", label: t("targets.col.scope") },
    { key: "probe", label: t("targets.col.probe") },
    { key: "actions", label: manage ? t("targets.col.actions") : "", className: "text-right" },
  ];

  return (
    <AppShell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t("targets.title")}</h1>
        {manage ? (
          <Button variant="primary" onClick={() => setShowForm((value) => !value)}>
            {t("targets.add")}
          </Button>
        ) : null}
      </div>

      {!manage ? (
        <Panel tone="lock" className="mt-4 p-3.5">
          <div className="font-mono text-[10px] tracking-[0.13em] uppercase text-muted-foreground">
            {t("targets.viewer.title")}
          </div>
          <p className="mt-1 text-[12.5px] text-muted-foreground text-pretty">{t("targets.viewer.text")}</p>
        </Panel>
      ) : null}

      {showForm && manage ? (
        <Panel tone="section" className="mt-5 p-5">
          <TargetForm onDone={() => setShowForm(false)} />
        </Panel>
      ) : null}

      <div className="mt-6">
        {targets.isPending ? (
          <LoadingState />
        ) : targets.isError ? (
          <ErrorState message={targets.error.message} onRetry={() => void targets.refetch()} />
        ) : targets.data.length === 0 ? (
          <EmptyState message={t("targets.empty")} />
        ) : (
          <RuledList>
            <ColumnHeaders columns={columns} gridClassName={ROW_GRID} />
            {targets.data.map((target) =>
              editingId === target.id ? (
                <Panel key={target.id} tone="section" className="m-3 p-5">
                  <TargetForm onDone={() => setEditingId(null)} target={target} />
                </Panel>
              ) : (
                <TargetRow
                  key={target.id}
                  target={target}
                  role={role}
                  policies={policies.data ?? []}
                  onEdit={() => setEditingId(target.id)}
                />
              ),
            )}
          </RuledList>
        )}
      </div>
    </AppShell>
  );
}
