// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useT } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";

// Loading and error states for every network operation — never an infinite spinner.
export function LoadingState() {
  const t = useT();
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <span className="sr-only">{t("common.loading")}</span>
    </div>
  );
}

// A refusal with its reason, in the error tone — and a way back, because a dead end at the top of
// a screen is worse than the failure it reports.
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <Panel role="alert" tone="error">
      <p className="font-medium text-destructive-text">{t("common.error")}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t("common.errorDetail", { message })}</p>
      {onRetry !== undefined ? (
        <Button variant="quiet" size="sm" className="mt-3" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      ) : null}
    </Panel>
  );
}

// Says what would fill it, never just "no data".
export function EmptyState({ message }: { message: string }) {
  return (
    <Panel tone="empty" className="p-8">
      {message}
    </Panel>
  );
}
