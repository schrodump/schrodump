// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { DestinationForm } from "@/components/destination-form";
import { ErrorState, EmptyState, LoadingState } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCanary } from "@/hooks/use-mutations";
import { useDestinations } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import type { Destination } from "@/lib/types";

function Canary({ destinationId }: { destinationId: string }) {
  const t = useT();
  const canary = useCanary();
  const failedOp = canary.data?.failedOperation ?? "?";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => canary.mutate(destinationId)} disabled={canary.isPending}>
        {canary.isPending ? t("common.loading") : t("destinations.canary")}
      </Button>
      {canary.isSuccess && canary.data.ok ? (
        <span className="text-sm text-[var(--color-state-verified)]">{t("destinations.canary.ok")}</span>
      ) : null}
      {canary.isSuccess && !canary.data.ok ? (
        <span className="text-sm text-[var(--color-state-failed)]">
          {t("destinations.canary.failed", { op: failedOp })}
        </span>
      ) : null}
      {canary.isError ? (
        <span className="text-sm text-[var(--color-state-failed)]">{canary.error.message}</span>
      ) : null}
    </div>
  );
}

function DestinationRow({ destination }: { destination: Destination }) {
  const t = useT();
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-6">
        <div>
          <p className="font-medium">{destination.name}</p>
          <p className="text-sm text-muted-foreground">
            {destination.bucket}
            {destination.prefix ? `/${destination.prefix}` : ""} · {t(`sealMode.${destination.sealMode}`)}
          </p>
        </div>
        <div className="ml-auto">
          <Canary destinationId={destination.id} />
        </div>
      </CardContent>
    </Card>
  );
}

export default function DestinationsPage() {
  const t = useT();
  const destinations = useDestinations();
  const [showForm, setShowForm] = useState(false);

  return (
    <AppShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("destinations.title")}</h1>
        <Button onClick={() => setShowForm((value) => !value)}>{t("destinations.add")}</Button>
      </div>

      {showForm ? (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <DestinationForm onDone={() => setShowForm(false)} />
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 space-y-3">
        {destinations.isPending ? (
          <LoadingState />
        ) : destinations.isError ? (
          <ErrorState message={destinations.error.message} onRetry={() => void destinations.refetch()} />
        ) : destinations.data.length === 0 ? (
          <EmptyState message={t("destinations.empty")} />
        ) : (
          destinations.data.map((destination) => (
            <DestinationRow key={destination.id} destination={destination} />
          ))
        )}
      </div>
    </AppShell>
  );
}
