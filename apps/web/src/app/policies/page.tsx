// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { CronReading } from "@/components/cron-reading";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { PolicyForm } from "@/components/policy-form";
import { ColumnHeaders, RuledList } from "@/components/ruled-list";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useDeletePolicy, useTriggerBackup, useUpdatePolicy } from "@/hooks/use-mutations";
import { useInstance, usePolicies } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { canManageTargets, type Role } from "@/lib/domain";
import type { Policy } from "@/lib/types";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_9rem_auto]";

// One row per policy: what it is and how deep it verifies, when it runs (the cron is the source
// of truth, with a reading and the next firing beside it), what it keeps, and the actions. Three
// conditions put a persistent warning under the row — not a toast, because each one means backups
// are quietly not doing what someone assumed.
export function PolicyRow({
  policy,
  role = "viewer",
  now = new Date(),
  onEdit,
}: {
  policy: Policy;
  role?: Role;
  now?: Date;
  onEdit?: () => void;
}) {
  const t = useT();
  const trigger = useTriggerBackup();
  const update = useUpdatePolicy();
  const remove = useDeletePolicy();
  const [confirming, setConfirming] = useState(false);
  const manage = canManageTargets(role);

  // Retention prunes only after a SUCCEEDED backup of this policy, so disabling it also stops it
  // deleting. That is the safe direction, but it is not obvious, and a retention window the
  // operator believes is running is exactly the silent state this project exists to surface.
  const retains =
    policy.keepLast > 0 || policy.keepDaily > 0 || policy.keepWeekly > 0 || policy.keepMonthly > 0 || policy.keepYearly > 0;
  const warnings = [
    policy.verifyLevel === "NONE" ? { title: t("policies.verifyOff.title"), body: t("policies.verifyOff.description") } : null,
    !retains ? { title: t("policies.retentionOff.title"), body: t("policies.retentionOff.description") } : null,
    !policy.enabled && retains
      ? { title: t("policies.disabledRetention.title"), body: t("policies.disabledRetention.description") }
      : null,
  ].filter((w): w is { title: string; body: string } => w !== null);
  const keep = [policy.keepLast, policy.keepDaily, policy.keepWeekly, policy.keepMonthly, policy.keepYearly].join(" / ");

  return (
    <div className="border-b border-border">
      <div className={cn("grid items-start gap-x-4 gap-y-2 px-[18px] py-3", ROW_GRID)}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{policy.name}</span>
            {!policy.enabled ? (
              <span className="rounded-sm border border-border-region bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-[0.13em] uppercase text-muted-foreground">
                {t("policies.disabled")}
              </span>
            ) : null}
          </div>
          <div className={cn("mt-0.5 font-mono text-[11.5px]", policy.verifyLevel === "NONE" ? "text-caution" : "text-muted-foreground")}>
            {t("policies.verifyLine", { level: t(`verifyLevel.${policy.verifyLevel}`) })}
          </div>
        </div>

        <div className="min-w-0">
          <div className="font-mono text-[12.5px]">{policy.cron}</div>
          <CronReading cron={policy.cron} enabled={policy.enabled} now={now} className="mt-0.5 text-[11px]" />
        </div>

        <div className="font-mono text-[12.5px] tabular-nums">{keep}</div>

        {manage ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button size="sm" variant="accent" onClick={() => trigger.mutate(policy.id)} disabled={trigger.isPending}>
              {trigger.isPending ? t("common.loading") : t("policies.trigger")}
            </Button>
            {onEdit !== undefined ? (
              <Button size="sm" variant="quiet" onClick={onEdit}>
                {t("common.edit")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="quiet"
              onClick={() => update.mutate({ id: policy.id, body: { enabled: !policy.enabled } })}
              disabled={update.isPending}
            >
              {t(policy.enabled ? "policies.disable" : "policies.enable")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} disabled={confirming}>
              {t("common.delete")}
            </Button>
          </div>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div className="space-y-2 px-[18px] pb-3">
          {warnings.map((warning) => (
            <Panel key={warning.title} tone="warning" className="p-3">
              <div className="text-[12.5px] font-medium text-caution">{warning.title}</div>
              <p className="mt-0.5 text-[12px] text-pretty">{warning.body}</p>
            </Panel>
          ))}
        </div>
      ) : null}

      {trigger.isSuccess ? (
        <p role="status" className="px-[18px] pb-3 font-mono text-[11px] text-state-verified">
          {t("policies.triggered")}
        </p>
      ) : null}
      {trigger.isError ? (
        <div className="px-[18px] pb-3">
          <ErrorState message={trigger.error.message} />
        </div>
      ) : null}
      {update.isError ? (
        <div className="px-[18px] pb-3">
          <ErrorState message={update.error.message} />
        </div>
      ) : null}

      {confirming ? (
        <div className="px-[18px] pb-3">
          <Panel tone="danger" className="flex flex-wrap items-center gap-3 p-3.5">
            <span className="min-w-0 flex-1 text-[12.5px]">{t("policies.delete.confirm")}</span>
            <Button type="button" size="sm" variant="quiet" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" size="sm" variant="danger" onClick={() => remove.mutate(policy.id)} disabled={remove.isPending}>
              {remove.isPending ? t("common.loading") : t("policies.delete.submit")}
            </Button>
          </Panel>
          {/* The server answers a refused delete with 409 and a reason that names what still
              depends on the row. Surfacing it verbatim is the whole point. */}
          {remove.isError ? (
            <div className="mt-2">
              <ErrorState message={`${t("config.refused")} — ${remove.error.message}`} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function PoliciesPage() {
  const t = useT();
  const role = useCurrentRole();
  const policies = usePolicies();
  const instance = useInstance();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const manage = canManageTargets(role);
  // Whether this deploy can stage a dump or sandbox a restore: the single most consequential
  // fact about it, and the API says so. Unknown reads as not configured — the form then withholds
  // the staged mode with its reason, which is the honest default while the answer loads.
  const scratchConfigured = instance.data?.scratch.configured ?? false;

  const columns = [
    { key: "policy", label: t("policies.col.policy") },
    { key: "schedule", label: t("policies.col.schedule") },
    { key: "keep", label: t("policies.col.keep") },
    { key: "actions", label: manage ? t("policies.col.actions") : "", className: "text-right" },
  ];

  return (
    <AppShell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold">{t("policies.title")}</h1>
          <p className="mt-2 text-sm text-muted-foreground text-pretty">{t("policies.intro")}</p>
        </div>
        {manage ? (
          <Button variant="primary" onClick={() => setShowForm((value) => !value)}>
            {t("policies.add")}
          </Button>
        ) : null}
      </div>

      {!manage ? (
        <Panel tone="lock" className="mt-4 p-3.5">
          <p className="text-[12.5px] text-muted-foreground text-pretty">{t("config.viewerLocked")}</p>
        </Panel>
      ) : null}

      {showForm && manage ? (
        <Panel tone="section" className="mt-5 p-5">
          <PolicyForm onDone={() => setShowForm(false)} scratchConfigured={scratchConfigured} />
        </Panel>
      ) : null}

      <div className="mt-6">
        {policies.isPending ? (
          <LoadingState />
        ) : policies.isError ? (
          <ErrorState message={policies.error.message} onRetry={() => void policies.refetch()} />
        ) : policies.data.length === 0 ? (
          <EmptyState message={t("policies.empty")} />
        ) : (
          <RuledList>
            <ColumnHeaders columns={columns} gridClassName={ROW_GRID} />
            {policies.data.map((policy) =>
              editingId === policy.id ? (
                <Panel key={policy.id} tone="section" className="m-3 p-5">
                  <PolicyForm onDone={() => setEditingId(null)} scratchConfigured={scratchConfigured} policy={policy} />
                </Panel>
              ) : (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  role={role}
                  onEdit={() => setEditingId(policy.id)}
                />
              ),
            )}
          </RuledList>
        )}
      </div>
    </AppShell>
  );
}
