// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DestinationForm } from "@/components/destination-form";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { LastCheck } from "@/components/last-check";
import { ColumnHeaders } from "@/components/ruled-list";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useCanary, useDeleteDestination } from "@/hooks/use-mutations";
import { useDestinations } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { canManageTargets, type Role } from "@/lib/domain";
import type { Destination } from "@/lib/types";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_11rem_auto]";

// What a destination is, where the bucket lives, and what the last canary recorded. Everything a
// canary or a delete comes back with renders under the row it is about. The role is the second
// lock: a viewer sees no actions, and the server refuses the calls regardless.
export function DestinationRow({
  destination,
  role = "viewer",
  onEdit,
}: {
  destination: Destination;
  role?: Role;
  onEdit?: () => void;
}) {
  const t = useT();
  const canary = useCanary();
  const remove = useDeleteDestination();
  const [confirming, setConfirming] = useState(false);
  const manage = canManageTargets(role);
  const locator = `${destination.bucket}${destination.prefix.length > 0 ? `/${destination.prefix}` : ""}`;
  const sealed = destination.sealMode === "sealed";

  return (
    <div className="border-b border-border">
      <div className={cn("grid items-start gap-x-4 gap-y-2 px-2 py-3", ROW_GRID)}>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium">{destination.name}</div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">{locator}</div>
          <div className={cn("mt-0.5 text-[12px]", sealed ? "text-caution" : "text-muted-foreground")}>
            {t(`sealMode.${destination.sealMode}`)}
          </div>
        </div>

        {/* Where the bucket actually lives: an operator running two R2 accounts and an S3 one could
            not tell them apart. endpoint is null for AWS (the region is the locator there);
            path-style is the flag some S3-compatibles need. */}
        <div className="min-w-0 font-mono text-[12px]">
          <div>{destination.region}</div>
          {destination.endpoint !== null ? (
            <div className="break-all text-muted-foreground">{destination.endpoint}</div>
          ) : (
            <div className="text-subtle-foreground">{t("destinations.awsNote")}</div>
          )}
          {destination.forcePathStyle ? (
            <span className="mt-1 inline-block rounded-sm border border-border-region bg-muted px-1.5 py-0.5 text-[10.5px] tracking-[0.06em] uppercase text-muted-foreground">
              {t("destinations.pathStyle")}
            </span>
          ) : null}
        </div>

        {/* The recorded canary. A bucket nobody has written to is an open question, and the row is
            where an operator looks for it. */}
        <div className="min-w-0">
          <LastCheck
            ok={destination.lastCanaryOk}
            at={destination.lastCanaryAt}
            keys={{
              never: "destinations.canary.never",
              lastOk: "destinations.canary.lastOk",
              lastFailed: "destinations.canary.lastFailed",
            }}
          />
        </div>

        {manage ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button size="sm" variant="quiet" onClick={() => canary.mutate(destination.id)} disabled={canary.isPending}>
              {canary.isPending ? t("common.loading") : t("destinations.canary")}
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

      {canary.isPending ? (
        <p className="px-2 pb-3 font-mono text-[11px] text-subtle-foreground">{t("destinations.canary.running")}</p>
      ) : null}
      {canary.isSuccess ? (
        <div className="px-2 pb-3">
          {canary.data.ok ? (
            <Panel tone="section" className="border-state-verified-border bg-state-verified-soft p-3">
              <div className="text-[12.5px] font-medium text-state-verified">{t("destinations.canary.ok")}</div>
            </Panel>
          ) : (
            <Panel tone="error" className="p-3">
              <div className="text-[12.5px] font-medium text-destructive-text">
                {t("destinations.canary.failed", { op: canary.data.failedOperation ?? "?" })}
              </div>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {t("destinations.canary.failedNote", { op: canary.data.failedOperation ?? "?" })}
              </p>
            </Panel>
          )}
        </div>
      ) : null}
      {canary.isError ? (
        <div className="px-2 pb-3">
          <ErrorState message={canary.error.message} />
        </div>
      ) : null}

      {confirming ? (
        <div className="px-2 pb-3">
          {/* A destination holding artifacts cannot be deleted: that row has the only credentials
              the system holds for the bucket. The server's 409 says how many are in the way. */}
          <Panel tone="danger" className="flex flex-wrap items-center gap-3 p-3.5">
            <span className="min-w-0 flex-1 text-[12.5px]">{t("destinations.delete.confirm")}</span>
            <Button type="button" size="sm" variant="quiet" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" size="sm" variant="danger" onClick={() => remove.mutate(destination.id)} disabled={remove.isPending}>
              {remove.isPending ? t("common.loading") : t("destinations.delete.submit")}
            </Button>
          </Panel>
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

export default function DestinationsPage() {
  const t = useT();
  const role = useCurrentRole();
  const destinations = useDestinations();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const manage = canManageTargets(role);

  const columns = [
    { key: "destination", label: t("destinations.col.destination") },
    { key: "where", label: t("destinations.col.where") },
    { key: "canary", label: t("destinations.col.canary") },
    { key: "actions", label: manage ? t("destinations.col.actions") : "", className: "text-right" },
  ];

  return (
    <AppShell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold">{t("destinations.title")}</h1>
          <p className="mt-2 text-sm text-muted-foreground text-pretty">{t("destinations.intro")}</p>
        </div>
        {manage ? (
          <Button variant="primary" onClick={() => setShowForm((value) => !value)}>
            {t("destinations.add")}
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
          <DestinationForm onDone={() => setShowForm(false)} />
        </Panel>
      ) : null}

      <div className="mt-6">
        {destinations.isPending ? (
          <LoadingState />
        ) : destinations.isError ? (
          <ErrorState message={destinations.error.message} onRetry={() => void destinations.refetch()} />
        ) : destinations.data.length === 0 ? (
          <EmptyState message={t("destinations.empty")} />
        ) : (
          <div>
            <ColumnHeaders columns={columns} gridClassName={ROW_GRID} />
            {destinations.data.map((destination) =>
              editingId === destination.id ? (
                <Panel key={destination.id} tone="section" className="my-3 p-5">
                  <DestinationForm onDone={() => setEditingId(null)} destination={destination} />
                </Panel>
              ) : (
                <DestinationRow
                  key={destination.id}
                  destination={destination}
                  role={role}
                  onEdit={() => setEditingId(destination.id)}
                />
              ),
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
