// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useInstance } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { formatBytes } from "@/lib/format";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

export function InstancePanel() {
  const t = useT();
  const query = useInstance();

  const body = (): React.ReactNode => {
    // 403 for a non-admin. Says so, rather than rendering an empty panel that reads as "this
    // deployment has no configuration" — the same choice the self-backup panel makes.
    if (query.isError)
      return <p className="text-sm text-muted-foreground">{t("instance.forbidden")}</p>;
    if (query.data === undefined)
      return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;

    const instance = query.data;
    return (
      <div className="space-y-2">
        <Row label={t("instance.version")} value={instance.version} />
        <Row
          label={t("instance.scratch")}
          // An unconfigured scratch is not a blank field: it is STREAM-only, which means no staged
          // dump, no verify sandbox and no restore. A dash would leave the operator to discover
          // that from a failed job.
          value={instance.scratch.path ?? t("instance.scratch.none")}
        />
        <Row label={t("instance.scratchMax")} value={formatBytes(instance.scratch.maxBytes)} />
        <Row
          label={t("instance.maxStaged")}
          value={String(instance.scratch.maxConcurrentStaged)}
        />
        <Row
          label={t("instance.stagedThreshold")}
          value={
            instance.stagedThresholdBytes === null
              ? t("instance.stagedThreshold.unset")
              : formatBytes(instance.stagedThresholdBytes)
          }
        />
        <Row label={t("instance.executorNetwork")} value={instance.executorNetwork} />
        <Row
          label={t("instance.selfBackup")}
          value={
            instance.selfBackup.configured
              ? t("instance.selfBackup.every", {
                  hours: String(Math.round(instance.selfBackup.intervalMs / 3_600_000)),
                })
              : t("instance.selfBackup.off")
          }
        />
        <Row
          label={t("instance.shutdownGrace")}
          value={t("instance.seconds", { seconds: String(instance.shutdownGraceMs / 1000) })}
        />
        <p className="pt-2 text-xs text-muted-foreground">{t("instance.readOnly")}</p>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.instance")}</CardTitle>
        <CardDescription>{t("settings.instance.description")}</CardDescription>
      </CardHeader>
      <CardContent>{body()}</CardContent>
    </Card>
  );
}
