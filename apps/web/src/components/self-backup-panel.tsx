// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSelfBackups } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import type { SelfBackup } from "@/lib/types";

// A self-backup that SUCCEEDED is amber, not green, and that is not a styling slip.
//
// SUCCEEDED here means the same thing it means everywhere else in this product: a process exited
// without complaining. Nobody restored this dump. Painting it green would be the one place in the
// UI that claims a backup is good because a job said so — which is the exact claim the whole
// product exists to refuse. Green is reserved for what a restore has actually opened.
const STATE_CLASS: Record<SelfBackup["state"], string> = {
  RUNNING: "bg-[var(--color-state-unobserved-bg)] text-[var(--color-state-unobserved)]",
  SUCCEEDED: "bg-[var(--color-state-unobserved-bg)] text-[var(--color-state-unobserved)]",
  FAILED: "bg-[var(--color-state-failed-bg)] text-[var(--color-state-failed)]",
};

export function SelfBackupPanel() {
  const t = useT();
  const query = useSelfBackups();

  const body = (): React.ReactNode => {
    // 403 for a non-admin. Says so, rather than rendering an empty panel that reads as "nothing
    // has ever happened here".
    if (query.isError)
      return <p className="text-sm text-muted-foreground">{t("selfBackup.forbidden")}</p>;
    if (query.data === undefined)
      return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;

    if (!query.data.configured)
      return (
        <div>
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
              "bg-[var(--color-state-unobserved-bg)] text-[var(--color-state-unobserved)]",
            )}
          >
            {t("selfBackup.notConfigured")}
          </span>
          <p className="mt-2 text-sm text-muted-foreground">{t("selfBackup.notConfigured.hint")}</p>
        </div>
      );

    const latest = query.data.items[0];
    if (latest === undefined)
      return <p className="text-sm text-muted-foreground">{t("selfBackup.never")}</p>;

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-state={latest.state}
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
              STATE_CLASS[latest.state],
            )}
          >
            {t(`selfBackup.state.${latest.state}`)}
          </span>
          <span className="text-sm text-muted-foreground">
            {t("selfBackup.lastRun", {
              when: new Date(latest.finishedAt ?? latest.startedAt).toLocaleString(),
            })}
          </span>
        </div>
        {latest.sizeBytes !== null ? (
          <p className="text-sm text-muted-foreground">
            {t("selfBackup.size", { size: formatBytes(latest.sizeBytes) })}
          </p>
        ) : null}
        {latest.reason !== null ? (
          <p className="text-sm text-[var(--color-state-failed)]">
            {t("selfBackup.reason", { reason: latest.reason })}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{t("selfBackup.escrow")}</p>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("selfBackup.title")}</CardTitle>
        <CardDescription>{t("selfBackup.description")}</CardDescription>
      </CardHeader>
      <CardContent>{body()}</CardContent>
    </Card>
  );
}
