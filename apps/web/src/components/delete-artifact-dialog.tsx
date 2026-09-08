// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorState } from "@/components/feedback";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDeleteArtifact } from "@/hooks/use-mutations";
import { useT } from "@/i18n/provider";
import { canDeleteArtifact, type Role } from "@/lib/domain";
import { formatBytes } from "@/lib/format";
import type { Artifact } from "@/lib/types";

// Deletion is irreversible and reaches the bucket, not just the catalog: the object, its manifest
// and (for postgres) the globals sidecar are gone for good. So the dialog leads with WHAT is being
// deleted — its state badge, engine and size — and gates the button behind retyping the artifact's
// short id. A VERIFIED artifact adds a second gate: a restore has proven this one restores, and
// throwing that away must be an explicit acknowledgement, never a reflex.
export function DeleteArtifactDialog({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const t = useT();
  const del = useDeleteArtifact();
  const token = artifact.id.slice(0, 8);
  const isVerified = artifact.state === "VERIFIED";
  const [confirm, setConfirm] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const tokenMatches = confirm === token;
  const canSubmit = tokenMatches && (!isVerified || acknowledge);

  // Driven by the button's onClick, NOT the form's submit-on-click. In this stack a click on a
  // type="submit" button does not fire the form's submit event (verified in production — only
  // requestSubmit does), so the delete silently never ran: enabled button, no request, no error.
  // The Verify button already drives its mutation from onClick for the same reason. The form's
  // onSubmit is kept so Enter in the input still confirms.
  function confirmDelete() {
    if (!canSubmit) return;
    del.mutate(
      { artifactId: artifact.id, acknowledgeVerified: acknowledge },
      { onSuccess: () => onClose() },
    );
  }

  // Rendered through a portal to document.body, NOT inline. The trigger lives inside the artifact
  // row's `<span onClick={preventDefault}>` (which stops a click from toggling the <details> row),
  // and an inline dialog is a DOM descendant of that span — so a click on the submit button bubbles
  // up to it and preventDefault cancels the form submit, silently. The portal moves the dialog out
  // of that subtree so the submit is never swallowed. See RestoreDialog, which had the same trap.
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-artifact-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          confirmDelete();
        }}
        className="max-h-full w-full max-w-lg space-y-4 overflow-auto rounded-lg border border-border bg-background p-6 shadow-lg"
      >
        <div>
          <h2 id="delete-artifact-title" className="text-lg font-semibold">
            {t("artifacts.delete.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("artifacts.delete.description")}</p>
        </div>

        <div className="flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
          <StatusBadge state={artifact.state} />
          <span>{t(`engine.${artifact.engine}`)}</span>
          <span className="text-muted-foreground">{formatBytes(artifact.sizeCompressedBytes)}</span>
        </div>

        {isVerified ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledge}
              onChange={(event) => setAcknowledge(event.target.checked)}
            />
            <span className="text-[var(--color-state-failed)]">
              {t("artifacts.delete.verifiedAck")}
            </span>
          </label>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="delete-confirm">
            {t("artifacts.delete.confirmPrompt", { token })}
          </Label>
          <Input
            id="delete-confirm"
            value={confirm}
            autoComplete="off"
            onChange={(event) => setConfirm(event.target.value)}
          />
          {confirm.length > 0 && !tokenMatches ? (
            <p className="text-sm text-[var(--color-state-failed)]">
              {t("artifacts.delete.mismatch")}
            </p>
          ) : null}
        </div>

        {del.isError ? <ErrorState message={del.error.message} /> : null}

        <div className="flex gap-2">
          <Button
            type="button"
            variant="destructive"
            disabled={!canSubmit || del.isPending}
            onClick={confirmDelete}
          >
            {del.isPending ? t("common.loading") : t("artifacts.delete.submit")}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
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
