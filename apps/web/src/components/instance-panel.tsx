// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AdminOnly, LoadingLine, SettingsPanel } from "@/components/settings-panel";
import { DetailGrid } from "@/components/ui/detail-grid";
import { useInstance } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { formatBytes } from "@/lib/format";

export function InstancePanel() {
  const t = useT();
  const query = useInstance();

  const body = (): React.ReactNode => {
    // 403 for a non-admin. Says so, rather than rendering an empty panel that reads as "this
    // deployment has no configuration" — the same choice the self-backup panel makes.
    if (query.isError) return <AdminOnly>{t("instance.forbidden")}</AdminOnly>;
    if (query.data === undefined) return <LoadingLine />;

    const instance = query.data;
    return (
      <div className="space-y-3">
        <DetailGrid
          facts={[
            { label: t("instance.version"), value: instance.version },
            // An unconfigured scratch is not a blank field: it is STREAM-only, which means no staged
            // dump, no verify sandbox and no restore. A dash would leave the operator to discover
            // that from a failed job.
            {
              label: t("instance.scratch"),
              value: instance.scratch.path ?? t("instance.scratch.none"),
              tone: instance.scratch.path === null ? "caution" : "plain",
            },
            { label: t("instance.scratchMax"), value: formatBytes(instance.scratch.maxBytes) },
            { label: t("instance.maxStaged"), value: String(instance.scratch.maxConcurrentStaged) },
            {
              label: t("instance.stagedThreshold"),
              value:
                instance.stagedThresholdBytes === null
                  ? t("instance.stagedThreshold.unset")
                  : formatBytes(instance.stagedThresholdBytes),
            },
            { label: t("instance.executorNetwork"), value: instance.executorNetwork },
            {
              label: t("instance.selfBackup"),
              value: instance.selfBackup.configured
                ? t("instance.selfBackup.every", { hours: String(Math.round(instance.selfBackup.intervalMs / 3_600_000)) })
                : t("instance.selfBackup.off"),
            },
            { label: t("instance.shutdownGrace"), value: t("instance.seconds", { seconds: String(instance.shutdownGraceMs / 1000) }) },
          ]}
        />
        <p className="text-[12px] text-muted-foreground text-pretty">{t("instance.readOnly")}</p>
      </div>
    );
  };

  return (
    <SettingsPanel title={t("settings.instance")} description={t("settings.instance.description")}>
      {body()}
    </SettingsPanel>
  );
}
