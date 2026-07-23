// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTriggerVerify } from "@/hooks/use-mutations";
import { useArtifacts } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { formatBytes } from "@/lib/format";
import type { Artifact } from "@/lib/types";

function ArtifactRow({ artifact }: { artifact: Artifact }) {
  const t = useT();
  const verify = useTriggerVerify();
  const key = artifact.keyIds[0] ?? "—";
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-6">
        <StatusBadge state={artifact.state} />
        <div className="min-w-0">
          <p className="truncate font-medium">{artifact.bucketKey}</p>
          <p className="text-sm text-muted-foreground">
            {t(`engine.${artifact.engine}`)} · {t("artifacts.size", { size: formatBytes(artifact.sizeCompressedBytes) })} ·{" "}
            {t("artifacts.key", { key })}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => verify.mutate(artifact.id)}
          disabled={verify.isPending}
        >
          {verify.isPending ? t("common.loading") : t("artifacts.verify")}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function ArtifactsPage() {
  const t = useT();
  const artifacts = useArtifacts();

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">{t("artifacts.title")}</h1>

      <div className="mt-6 space-y-3">
        {artifacts.isPending ? (
          <LoadingState />
        ) : artifacts.isError ? (
          <ErrorState message={artifacts.error.message} onRetry={() => void artifacts.refetch()} />
        ) : artifacts.data.length === 0 ? (
          <EmptyState message={t("artifacts.empty")} />
        ) : (
          artifacts.data.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} />)
        )}
      </div>
    </AppShell>
  );
}
