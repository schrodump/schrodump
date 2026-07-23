// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ErrorState, EmptyState, LoadingState } from "@/components/feedback";
import { TargetForm } from "@/components/target-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTestConnection } from "@/hooks/use-mutations";
import { useTargets } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import type { Target } from "@/lib/types";

function TestConnection({ targetId }: { targetId: string }) {
  const t = useT();
  const test = useTestConnection();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => test.mutate(targetId)} disabled={test.isPending}>
        {test.isPending ? t("common.loading") : t("targets.testConnection")}
      </Button>
      {test.isSuccess && test.data.ok ? (
        <span className="text-sm text-[var(--color-state-verified)]">
          {test.data.serverVersionNum !== null
            ? t("targets.probe.version", { version: test.data.serverVersionNum })
            : t("targets.probe.ok")}
        </span>
      ) : null}
      {test.isSuccess && !test.data.ok ? (
        <span className="text-sm text-[var(--color-state-failed)]">{t("targets.probe.failed")}</span>
      ) : null}
      {test.isError ? (
        <span className="text-sm text-[var(--color-state-failed)]">{t("targets.probe.failed")}</span>
      ) : null}
      {test.isSuccess ? (
        <span className="text-xs text-muted-foreground">{t("targets.probe.limited")}</span>
      ) : null}
    </div>
  );
}

function TargetRow({ target }: { target: Target }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-6">
        <div>
          <p className="font-medium">{target.name}</p>
          <p className="text-sm text-muted-foreground">
            {target.engine} · {target.host}:{target.port}
          </p>
        </div>
        <div className="ml-auto">
          <TestConnection targetId={target.id} />
        </div>
      </CardContent>
    </Card>
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

      <div className="mt-6 space-y-3">
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
