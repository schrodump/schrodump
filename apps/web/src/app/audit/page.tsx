// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { useAuditLog } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { formatDateTime } from "@/lib/format";
import type { AuditEntry } from "@/lib/types";

// The trail the server has kept since the first migration and never showed: who did what, when.
// Exported so a row can be asserted directly.
export function AuditRow({ entry }: { entry: AuditEntry }) {
  const t = useT();
  return (
    <div className="space-y-2 border-b border-border px-2 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-mono text-sm font-medium">{entry.action}</span>
        {/* A null actor is a job's own credential read, attributed by correlation, not a person —
            "system", never a blank that reads as missing data. */}
        <span className="text-sm text-muted-foreground">{entry.actorEmail ?? t("audit.system")}</span>
        {entry.targetType !== null ? (
          <span className="font-mono text-xs text-muted-foreground">
            {entry.targetType}
            {entry.targetId !== null ? `:${entry.targetId.slice(0, 8)}` : ""}
          </span>
        ) : null}
        <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
          {formatDateTime(entry.createdAt)}
        </span>
      </div>
      <code className="block rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
        {entry.correlationId}
      </code>
    </div>
  );
}

export default function AuditPage() {
  const t = useT();
  const audit = useAuditLog();

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">{t("audit.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("audit.description")}</p>

      <div className="mt-6">
        {audit.isPending ? (
          <LoadingState />
        ) : audit.isError ? (
          <ErrorState message={audit.error.message} onRetry={() => void audit.refetch()} />
        ) : audit.data.items.length === 0 ? (
          <EmptyState message={t("audit.empty")} />
        ) : (
          <>
            <div className="border-t border-border">
              {audit.data.items.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </div>
            {audit.data.total > audit.data.items.length ? (
              <p className="pt-2 text-sm text-muted-foreground">
                {t("list.truncated", {
                  shown: audit.data.items.length,
                  total: audit.data.total,
                })}
              </p>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}
