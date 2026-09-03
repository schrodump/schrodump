// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LastCheck } from "@/components/last-check";
import { ErrorState, EmptyState, LoadingState } from "@/components/feedback";
import { TargetForm } from "@/components/target-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useDeleteTarget, useTestConnection } from "@/hooks/use-mutations";
import { useTargets } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { formatServerVersion } from "@/lib/format";
import type { Target } from "@/lib/types";

function TestConnection({ targetId }: { targetId: string }) {
  const t = useT();
  const test = useTestConnection();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => test.mutate(targetId)}
        disabled={test.isPending}
      >
        {test.isPending ? t("common.loading") : t("targets.testConnection")}
      </Button>
      {test.isSuccess && test.data.ok ? (
        <span className="text-sm text-[var(--color-state-verified)]">
          {test.data.serverVersionNum !== null
            ? t("targets.probe.version", {
                version: formatServerVersion(test.data.serverVersionNum),
              })
            : t("targets.probe.ok")}
        </span>
      ) : null}
      {test.isSuccess && !test.data.ok ? (
        <span className="text-sm text-[var(--color-state-failed)]">
          {t("targets.probe.failed")} {t(`targets.probe.reason.${test.data.failure ?? "UNKNOWN"}`)}
          {/* Shown only when the classification gave up: otherwise it is noise, but on an UNKNOWN
              it is the difference between a reportable failure and a dead end. */}
          {test.data.failure === "UNKNOWN" && test.data.driverCode !== null
            ? ` ${t("targets.probe.driverCode", { code: test.data.driverCode })}`
            : ""}
        </span>
      ) : null}
      {test.isError ? (
        <span className="text-sm text-[var(--color-state-failed)]">
          {t("targets.probe.failed")}
        </span>
      ) : null}
      {/* Only alongside a success: on a failure this reads as if the probe ran and came back thin,
          which is the wrong thing to tell someone whose connection did not work at all. */}
      {test.isSuccess && test.data.ok ? (
        <span className="text-xs text-muted-foreground">{t("targets.probe.limited")}</span>
      ) : null}
    </div>
  );
}

function TargetRow({ target }: { target: Target }) {
  const t = useT();
  const remove = useDeleteTarget();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <Card>
        <CardContent className="pt-6">
          <TargetForm onDone={() => setEditing(false)} target={target} />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2 border-b border-border px-2 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className="font-medium">{target.name}</p>
            <p className="font-mono text-xs text-[var(--color-foreground-soft)]">
              {target.engine} · {target.host}:{target.port}
            </p>
            {/* The recorded probe, which the row never showed: the guided checklist reads it and
                this is where an operator actually looks. Never-run is amber, not a grey dash —
                it is an open question, and a dash reads as "not applicable". */}
            <LastCheck
              ok={target.lastProbeOk}
              at={target.lastProbeAt}
              keys={{
                never: "targets.probe.never",
                lastOk: "targets.probe.lastOk",
                lastFailed: "targets.probe.lastFailed",
              }}
            />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <TestConnection targetId={target.id} />
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {t("common.edit")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => remove.mutate(target.id)}
              disabled={remove.isPending}
            >
              {t("common.delete")}
            </Button>
          </div>
        </div>
        {/* The server refuses a delete with 409 and a reason naming what still depends on the row.
            Showing it verbatim is the point — "in use" on its own is not actionable. */}
      {remove.isError ? <ErrorState message={remove.error.message} /> : null}
    </div>
  );
}

export default function TargetsPage() {
  const t = useT();
  const targets = useTargets();
  const [showForm, setShowForm] = useState(false);

  return (
    <AppShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("targets.title")}</h1>
        <Button onClick={() => setShowForm((value) => !value)}>{t("targets.add")}</Button>
      </div>

      {showForm ? (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <TargetForm onDone={() => setShowForm(false)} />
          </CardContent>
        </Card>
      ) : null}

      {/* A ruled list rather than a stack of cards: the rows are siblings, not
          separate objects. */}
      <div className="mt-6 border-t border-border">
        {targets.isPending ? (
          <LoadingState />
        ) : targets.isError ? (
          <ErrorState message={targets.error.message} onRetry={() => void targets.refetch()} />
        ) : targets.data.length === 0 ? (
          <EmptyState message={t("targets.empty")} />
        ) : (
          targets.data.map((target) => <TargetRow key={target.id} target={target} />)
        )}
      </div>
    </AppShell>
  );
}
