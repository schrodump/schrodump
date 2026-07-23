// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ErrorState, EmptyState, LoadingState } from "@/components/feedback";
import { PolicyForm } from "@/components/policy-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTriggerBackup } from "@/hooks/use-mutations";
import { usePolicies } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import type { Policy } from "@/lib/types";

// No instance-config endpoint exposes whether scratch is configured on the deploy, so the form
// assumes it is available. The ParallelismField still supports the disabled-with-reason state.
const SCRATCH_CONFIGURED = true;

function PolicyRow({ policy }: { policy: Policy }) {
  const t = useT();
  const trigger = useTriggerBackup();
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className="font-medium">{policy.name}</p>
            <p className="text-sm text-muted-foreground">
              {policy.cron} · {t(`verifyLevel.${policy.verifyLevel}`)}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => trigger.mutate(policy.id)}
            disabled={trigger.isPending}
          >
            {trigger.isPending ? t("common.loading") : t("policies.trigger")}
          </Button>
        </div>
        {/* Persistent warning — not a toast — when verify is off for this policy. */}
        {policy.verifyLevel === "NONE" ? (
          <Alert variant="warning">
            <AlertTitle>{t("policies.verifyOff.title")}</AlertTitle>
            <AlertDescription>{t("policies.verifyOff.description")}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function PoliciesPage() {
  const t = useT();
  const policies = usePolicies();
  const [showForm, setShowForm] = useState(false);

  return (
    <AppShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("policies.title")}</h1>
        <Button onClick={() => setShowForm((value) => !value)}>{t("policies.add")}</Button>
      </div>

      {showForm ? (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <PolicyForm onDone={() => setShowForm(false)} scratchConfigured={SCRATCH_CONFIGURED} />
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 space-y-3">
        {policies.isPending ? (
          <LoadingState />
        ) : policies.isError ? (
          <ErrorState message={policies.error.message} onRetry={() => void policies.refetch()} />
        ) : policies.data.length === 0 ? (
          <EmptyState message={t("policies.empty")} />
        ) : (
          policies.data.map((policy) => <PolicyRow key={policy.id} policy={policy} />)
        )}
      </div>
    </AppShell>
  );
}
