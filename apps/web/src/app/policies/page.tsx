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
import { useDeletePolicy, useTriggerBackup, useUpdatePolicy } from "@/hooks/use-mutations";
import { usePolicies } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import type { Policy } from "@/lib/types";

// No instance-config endpoint exposes whether scratch is configured on the deploy, so the form
// assumes it is available. The ParallelismField still supports the disabled-with-reason state.
const SCRATCH_CONFIGURED = true;

function PolicyRow({ policy, scratchConfigured }: { policy: Policy; scratchConfigured: boolean }) {
  const t = useT();
  const trigger = useTriggerBackup();
  const update = useUpdatePolicy();
  const remove = useDeletePolicy();
  const [editing, setEditing] = useState(false);

  // Retention prunes only after a SUCCEEDED backup of this policy, so disabling it also stops it
  // deleting. That is the safe direction, but it is not obvious, and a retention window the
  // operator believes is running is exactly the silent state this project exists to surface.
  const retains =
    policy.keepLast > 0 ||
    policy.keepDaily > 0 ||
    policy.keepWeekly > 0 ||
    policy.keepMonthly > 0 ||
    policy.keepYearly > 0;

  if (editing) {
    return (
      <Card>
        <CardContent className="pt-6">
          <PolicyForm
            onDone={() => setEditing(false)}
            scratchConfigured={scratchConfigured}
            policy={policy}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className="font-medium">
              {policy.name}
              {!policy.enabled ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {t("policies.disabled")}
                </span>
              ) : null}
            </p>
            <p className="text-sm text-muted-foreground">
              {policy.cron} · {t(`verifyLevel.${policy.verifyLevel}`)}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => trigger.mutate(policy.id)}
              disabled={trigger.isPending}
            >
              {trigger.isPending ? t("common.loading") : t("policies.trigger")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {t("common.edit")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => update.mutate({ id: policy.id, body: { enabled: !policy.enabled } })}
              disabled={update.isPending}
            >
              {t(policy.enabled ? "policies.disable" : "policies.enable")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => remove.mutate(policy.id)}
              disabled={remove.isPending}
            >
              {t("common.delete")}
            </Button>
          </div>
        </div>

        {/* Persistent warning — not a toast — when verify is off for this policy. */}
        {policy.verifyLevel === "NONE" ? (
          <Alert variant="warning">
            <AlertTitle>{t("policies.verifyOff.title")}</AlertTitle>
            <AlertDescription>{t("policies.verifyOff.description")}</AlertDescription>
          </Alert>
        ) : null}

        {/* Same reasoning as the verify warning: an unconfigured retention window is a decision
            being made by default, and it is retaining forever. Say so where it is visible. */}
        {!retains ? (
          <Alert variant="warning">
            <AlertTitle>{t("policies.retentionOff.title")}</AlertTitle>
            <AlertDescription>{t("policies.retentionOff.description")}</AlertDescription>
          </Alert>
        ) : null}

        {!policy.enabled && retains ? (
          <Alert variant="warning">
            <AlertTitle>{t("policies.disabledRetention.title")}</AlertTitle>
            <AlertDescription>{t("policies.disabledRetention.description")}</AlertDescription>
          </Alert>
        ) : null}

        {/* The server answers a refused delete with 409 and a reason that names what still depends
            on the row. Surfacing it verbatim is the whole point — "in use" alone is not actionable. */}
        {remove.isError ? <ErrorState message={remove.error.message} /> : null}
        {update.isError ? <ErrorState message={update.error.message} /> : null}
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
          policies.data.map((policy) => (
            <PolicyRow key={policy.id} policy={policy} scratchConfigured={SCRATCH_CONFIGURED} />
          ))
        )}
      </div>
    </AppShell>
  );
}
