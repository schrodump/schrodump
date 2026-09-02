// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { RestoreButton } from "@/components/restore-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useTriggerVerify } from "@/hooks/use-mutations";
import { useArtifacts } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { formatBytes } from "@/lib/format";
import type { Role } from "@/lib/domain";
import type { Artifact } from "@/lib/types";

// Exported so the row can be asserted directly. The page around it needs the resource hooks; the
// question this component answers — what does the operator actually SEE about an artifact — does
// not, and it is the question that matters.
export function ArtifactRow({ artifact, role }: { artifact: Artifact; role: Role }) {
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
            {t(`engine.${artifact.engine}`)} ·{" "}
            {t("artifacts.size", { size: formatBytes(artifact.sizeCompressedBytes) })} ·{" "}
            {t("artifacts.key", { key })}
            {/* Only when true. An archive WITH an oplog restores to a single instant; one without
                restores collection by collection, and nothing else on this row says which it is.
                null (a non-mongo engine) and false (a mongo dump with none) both stay silent —
                claiming "no oplog" for postgres would assert something about a database that has
                none. */}
            {artifact.sourceHasOplog === true ? <> · {t("artifacts.oplog")}</> : null}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => verify.mutate(artifact.id)}
            disabled={verify.isPending}
          >
            {verify.isPending ? t("common.loading") : t("artifacts.verify")}
          </Button>
          <RestoreButton artifact={artifact} role={role} />
        </div>
      </CardContent>
    </Card>
  );
}

export default function ArtifactsPage() {
  const t = useT();
  const artifacts = useArtifacts();
  const role = useCurrentRole();

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">{t("artifacts.title")}</h1>

      <div className="mt-6 space-y-3">
        {artifacts.isPending ? (
          <LoadingState />
        ) : artifacts.isError ? (
          <ErrorState message={artifacts.error.message} onRetry={() => void artifacts.refetch()} />
        ) : artifacts.data.items.length === 0 ? (
          <EmptyState message={t("artifacts.empty")} />
        ) : (
          <>
            {artifacts.data.items.map((artifact) => (
              <ArtifactRow key={artifact.id} artifact={artifact} role={role} />
            ))}
            {artifacts.data.total > artifacts.data.items.length ? (
              <p className="pt-2 text-sm text-muted-foreground">
                {t("list.truncated", {
                  shown: artifacts.data.items.length,
                  total: artifacts.data.total,
                })}
              </p>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}
