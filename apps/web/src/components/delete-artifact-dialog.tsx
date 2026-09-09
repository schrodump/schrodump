// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { ErrorState } from "@/components/feedback";
import { AcknowledgeCheckbox } from "@/components/ui/acknowledge-checkbox";
import { Button } from "@/components/ui/button";
import { DialogShell, SubjectRow } from "@/components/ui/dialog";
import { Panel } from "@/components/ui/panel";
import { RetypeToConfirm } from "@/components/ui/retype-to-confirm";
import { useDeleteArtifact } from "@/hooks/use-mutations";
import { useT } from "@/i18n/provider";
import { canDeleteArtifact, type Role } from "@/lib/domain";
import { formatBytes } from "@/lib/format";
import type { Artifact } from "@/lib/types";

// Deletion is irreversible and reaches the bucket, not just the catalog: the object, its manifest
// and (for postgres) the globals sidecar are gone for good. So the dialog leads with WHAT is being
// deleted — its state, what it is, its size — says exactly what leaves the bucket, and gates the
// button behind retyping the artifact's short id. A VERIFIED artifact adds a second gate: a restore
// has proven this one restores, and throwing that away must be an explicit acknowledgement, never
// a reflex. The primary action is never merely grey: it carries the reason it is blocked.
export function DeleteArtifactDialog({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const t = useT();
  const del = useDeleteArtifact();
  const token = artifact.id.slice(0, 8);
  const isVerified = artifact.state === "VERIFIED";
  const [confirm, setConfirm] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);

  const tokenMatches = confirm === token;
  const canSubmit = tokenMatches && (!isVerified || acknowledge);
  const blocked = canSubmit
    ? null
    : isVerified
      ? t("artifacts.delete.blocked.ack")
      : t("artifacts.delete.blocked.retype");

  // Driven by the button's onClick, NOT the form's submit-on-click: in this stack a click on a
  // type="submit" button does not fire the form's submit event (verified in production — only
  // requestSubmit does). The form's onSubmit is kept so Enter in the input still confirms.
  function confirmDelete() {
    if (!canSubmit) return;
    del.mutate(
      { artifactId: artifact.id, acknowledgeVerified: acknowledge },
      { onSuccess: () => onClose() },
    );
  }

  const engineLine = `${t(`engine.${artifact.engine}`)} / ${t(`executionMode.${artifact.executionMode}`)}`;

  return (
    <DialogShell
      titleId="delete-artifact-title"
      title={t("artifacts.delete.title")}
      description={t("artifacts.delete.description")}
      subject={
        <SubjectRow
          state={artifact.state}
          name={artifact.targetName ?? engineLine}
          facts={[
            ...(artifact.targetName !== null ? [engineLine] : []),
            formatBytes(artifact.sizeCompressedBytes),
            token,
          ]}
        />
      }
      footerHint={isVerified ? t("artifacts.delete.gates") : undefined}
      actions={
        <>
          <Button type="button" variant="quiet" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={confirmDelete}
            disabled={del.isPending}
            disabledReason={del.isPending ? null : blocked}
          >
            {del.isPending ? t("common.loading") : t("artifacts.delete.submit")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          confirmDelete();
        }}
        className="space-y-4"
      >
        <Panel tone="danger">
          <p className="font-medium text-destructive-text">{t("artifacts.delete.reaches")}</p>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            <li>
              — {t("artifacts.delete.object")}{" "}
              <span className="break-all text-muted-foreground">{artifact.bucketKey}</span>
            </li>
            <li>
              — {t("artifacts.delete.manifest")}{" "}
              <span className="break-all text-muted-foreground">{artifact.manifestKey}</span>
            </li>
            {artifact.engine === "postgres" ? <li>— {t("artifacts.delete.globals")}</li> : null}
          </ul>
          <p className="mt-2 text-sm">{t("artifacts.delete.noUndo")}</p>
        </Panel>

        {isVerified ? (
          <AcknowledgeCheckbox checked={acknowledge} onChange={setAcknowledge}>
            {t("artifacts.delete.verifiedAck")}
          </AcknowledgeCheckbox>
        ) : null}

        <RetypeToConfirm
          id="delete-confirm"
          label={t("artifacts.delete.retypeLabel")}
          hint={t("artifacts.delete.confirmPrompt", { token })}
          subject={token}
          value={confirm}
          onChange={setConfirm}
          mismatch={t("artifacts.delete.mismatch")}
        />

        {del.isError ? <ErrorState message={del.error.message} /> : null}
      </form>
    </DialogShell>
  );
}

// A viewer never sees the trigger. The server refuses the request regardless — this is the second
// lock, not the only one.
export function DeleteArtifactButton({ artifact, role }: { artifact: Artifact; role: Role }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!canDeleteArtifact(role)) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t("artifacts.delete")}
      </Button>
      {open ? <DeleteArtifactDialog artifact={artifact} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
