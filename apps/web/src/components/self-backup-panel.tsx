// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AdminOnly, LoadingLine, SettingsPanel } from "@/components/settings-panel";
import { useSelfBackups } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { formatBytes, formatRelative } from "@/lib/format";
import type { SelfBackup } from "@/lib/types";

// A self-backup that SUCCEEDED is amber, not green, and that is not a styling slip.
//
// SUCCEEDED here means the same thing it means everywhere else in this product: a process exited
// without complaining. Nobody restored this dump. Painting it green would be the one place in the
// UI that claims a backup is good because a job said so — which is the exact claim the whole
// product exists to refuse. Green is reserved for what a restore has actually opened.
const PILL: Record<SelfBackup["state"], string> = {
  RUNNING: "border-state-unobserved-border bg-state-unobserved-soft text-state-unobserved",
  SUCCEEDED: "border-state-unobserved-border bg-state-unobserved-soft text-state-unobserved",
  FAILED: "border-state-failed-border bg-state-failed-soft text-state-failed",
};

function Pill({ className, children, state }: { className: string; children: string; state?: SelfBackup["state"] }) {
  return (
    <span
      data-state={state}
      className={cn("inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[10.5px] tracking-[0.08em] uppercase", className)}
    >
      {children}
    </span>
  );
}

export function SelfBackupPanel() {
  const t = useT();
  const query = useSelfBackups();

  const body = (): React.ReactNode => {
    // 403 for a non-admin. Says so, rather than rendering an empty panel that reads as "nothing
    // has ever happened here".
    if (query.isError) return <AdminOnly>{t("selfBackup.forbidden")}</AdminOnly>;
    if (query.data === undefined) return <LoadingLine />;

    if (!query.data.configured)
      return (
        <div className="space-y-2">
          <Pill className={PILL.SUCCEEDED}>{t("selfBackup.notConfigured")}</Pill>
          <p className="text-[12.5px] text-muted-foreground text-pretty">{t("selfBackup.notConfigured.hint")}</p>
        </div>
      );

    const latest = query.data.items[0];
    if (latest === undefined) return <p className="text-[12.5px] text-muted-foreground">{t("selfBackup.never")}</p>;

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Pill className={PILL[latest.state]} state={latest.state}>
            {t(`selfBackup.state.${latest.state}`)}
          </Pill>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {t("selfBackup.lastRun", { when: formatRelative(latest.finishedAt ?? latest.startedAt) })}
          </span>
          {latest.sizeBytes !== null ? (
            <span className="font-mono text-[11.5px] text-muted-foreground">
              {t("selfBackup.size", { size: formatBytes(latest.sizeBytes) })}
            </span>
          ) : null}
        </div>
        {latest.state === "SUCCEEDED" ? (
          <p className="text-[12.5px] text-muted-foreground text-pretty">{t("selfBackup.writtenNote")}</p>
        ) : null}
        {latest.reason !== null ? (
          <p className="text-[12.5px] text-destructive-text">{t("selfBackup.reason", { reason: latest.reason })}</p>
        ) : null}
        <p className="text-[12px] text-subtle-foreground text-pretty">{t("selfBackup.escrow")}</p>
      </div>
    );
  };

  return (
    <SettingsPanel title={t("selfBackup.title")} description={t("selfBackup.description")}>
      {body()}
    </SettingsPanel>
  );
}
