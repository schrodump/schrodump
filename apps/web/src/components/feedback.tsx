// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useT } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
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

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-[var(--color-state-failed-bg)] p-4 text-[var(--color-state-failed)]"
    >
      <p className="font-medium">{t("common.error")}</p>
      <p className="mt-1 text-sm opacity-90">{t("common.errorDetail", { message })}</p>
      {onRetry !== undefined ? (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}
