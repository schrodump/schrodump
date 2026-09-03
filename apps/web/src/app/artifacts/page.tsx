// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { RestoreButton } from "@/components/restore-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useTriggerVerify } from "@/hooks/use-mutations";
import { useArtifacts } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { formatBytes, formatServerVersion } from "@/lib/format";
import type { Role } from "@/lib/domain";
import type { Artifact } from "@/lib/types";

// Exported so the row can be asserted directly. The page around it needs the resource hooks; the
// question this component answers — what does the operator actually SEE about an artifact — does
// not, and it is the question that matters.
//
// Two tiers, because there are nineteen fields and an operator arrives with one question. The
// summary line carries the scan: state, engine, size, age. Everything forensic — the bucket key,
// the checksum, which recipients it was sealed to — opens in place.
//
// A native <details>, not a script-driven panel: it is keyboard-operable and screen-reader
// announced for free, it survives with JavaScript still loading, and the content stays in the
// document so nothing is a route away. The bucket key used to be the HEADLINE of this row — a
// sixty-character storage path, the least useful string on it.
function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="font-mono text-[0.63rem] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="m-0 font-mono text-xs break-all text-[var(--color-foreground-soft)]">
        {children}
      </dd>
    </div>
  );
}

export function ArtifactRow({ artifact, role }: { artifact: Artifact; role: Role }) {
  const t = useT();
  const verify = useTriggerVerify();
  return (
    <details className="group border-b border-border">
      <summary className="grid cursor-pointer list-none grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-2 py-2.5 hover:bg-muted sm:grid-cols-[7.5rem_minmax(6rem,1fr)_6rem_5rem_auto] [&::-webkit-details-marker]:hidden">
        {/* justify-self, because a grid child stretches to its track by default and the chip would
            paint its background across the whole column — the badge has to hug its own word. */}
        <span className="justify-self-start">
          <StatusBadge state={artifact.state} />
        </span>
        <span className="font-mono text-sm font-medium">
          {t(`engine.${artifact.engine}`)}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            / {t(`executionMode.${artifact.executionMode}`)}
          </span>
        </span>
        <span className="hidden text-right font-mono text-xs tabular-nums text-[var(--color-foreground-soft)] sm:block">
          {formatBytes(artifact.sizeCompressedBytes)}
        </span>
        <span className="hidden font-mono text-xs text-muted-foreground sm:block">
          {artifact.createdAt.slice(11, 16)}
        </span>
        <span className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={(event) => {
              // The actions live inside the summary so they are reachable without opening the row.
              // Stopping propagation keeps a click on them from toggling the disclosure underneath.
              event.preventDefault();
              verify.mutate(artifact.id);
            }}
            disabled={verify.isPending}
          >
            {verify.isPending ? t("common.loading") : t("artifacts.verify")}
          </Button>
          <span onClick={(event) => event.preventDefault()}>
            <RestoreButton artifact={artifact} role={role} />
          </span>
        </span>
      </summary>

      <dl className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-x-8 gap-y-2 bg-muted px-2 pt-1 pb-4">
        <DetailField label={t("artifacts.detail.bucketKey")}>{artifact.bucketKey}</DetailField>
        <DetailField label={t("artifacts.detail.checksum")}>
          {artifact.checksumAlgorithm} · {artifact.checksum}
        </DetailField>
        <DetailField label={t("artifacts.detail.raw")}>
          {formatBytes(artifact.sizeRawBytes)}
        </DetailField>
        <DetailField label={t("artifacts.detail.compression")}>{artifact.compression}</DetailField>
        <DetailField label={t("artifacts.detail.server")}>
          {formatServerVersion(artifact.serverVersionNum)}
        </DetailField>
        <DetailField label={t("artifacts.detail.sealedTo")}>
          {artifact.keyIds.join(" · ")}
        </DetailField>
        {/* Only when true, which is the rule this row already had and this pass does not relitigate:
            an archive WITH an oplog restores to a single instant. `false` (a mongo dump carrying
            none) and `null` (an engine that has no such thing) both stay silent. Whether a recorded
            `false` deserves to be said out loud for mongo is a product question, not a visual one,
            and it is raised separately. */}
        {artifact.sourceHasOplog === true ? (
          <DetailField label={t("artifacts.detail.provenance")}>{t("artifacts.oplog")}</DetailField>
        ) : null}
      </dl>
    </details>
  );
}

export default function ArtifactsPage() {
  const t = useT();
  const artifacts = useArtifacts();
  const role = useCurrentRole();

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">{t("artifacts.title")}</h1>

      <div className="mt-6">
        {artifacts.isPending ? (
          <LoadingState />
        ) : artifacts.isError ? (
          <ErrorState message={artifacts.error.message} onRetry={() => void artifacts.refetch()} />
        ) : artifacts.data.items.length === 0 ? (
          <EmptyState message={t("artifacts.empty")} />
        ) : (
          <>
            {/* A ruled list rather than a stack of cards: forty equally-boxed objects ask the eye
                to separate what the content already separates. */}
            <div className="border-t border-border">
              {artifacts.data.items.map((artifact) => (
                <ArtifactRow key={artifact.id} artifact={artifact} role={role} />
              ))}
            </div>
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
