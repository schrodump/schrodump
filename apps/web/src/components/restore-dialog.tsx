// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ErrorState } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTriggerRestore } from "@/hooks/use-mutations";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import {
  RESTORE_TARGETS,
  RESTORE_TARGETS_BY_ENGINE,
  canRestore,
  type RestoreTarget,
  type Role,
} from "@/lib/domain";
import type { Artifact } from "@/lib/types";

const targetLabel: Record<RestoreTarget, MessageKey> = {
  FULL_CLUSTER: "restoreTarget.FULL_CLUSTER",
  DATABASE: "restoreTarget.DATABASE",
  SCHEMA: "restoreTarget.SCHEMA",
  TABLE: "restoreTarget.TABLE",
  COLLECTION: "restoreTarget.COLLECTION",
};

export function RestoreDialog({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const t = useT();
  const restore = useTriggerRestore();
  const supported = RESTORE_TARGETS_BY_ENGINE[artifact.engine];

  const [target, setTarget] = useState<RestoreTarget>(supported[0] ?? "FULL_CLUSTER");
  const [database, setDatabase] = useState("");
  const [overExisting, setOverExisting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on open so keyboard users land inside it and Escape reaches the
  // handler below instead of the page behind.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const scoped = target !== "FULL_CLUSTER";
  const nameMatches = database.length > 0 && confirmName === database;
  // Friction is the point: overwriting an existing database stays blocked until the operator has
  // retyped its name exactly.
  const canSubmit = scoped ? database.length > 0 && (!overExisting || nameMatches) : true;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    restore.mutate({ artifactId: artifact.id, target, confirmExistingDatabase: overExisting });
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        className="max-h-full w-full max-w-lg space-y-4 overflow-auto rounded-lg border border-border bg-background p-6 shadow-lg"
      >
        <div>
          <h2 id="restore-title" className="text-lg font-semibold">
            {t("restore.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("restore.description")}</p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("restore.scope")}</legend>
          {RESTORE_TARGETS.map((option) => {
            const isSupported = supported.includes(option);
            return (
              <div key={option} className="flex items-center gap-2">
                <input
                  type="radio"
                  id={`target-${option}`}
                  name="restore-target"
                  value={option}
                  checked={target === option}
                  disabled={!isSupported}
                  onChange={() => setTarget(option)}
                />
                <Label htmlFor={`target-${option}`} className={isSupported ? "" : "text-muted-foreground"}>
                  {t(targetLabel[option])}
                </Label>
                {!isSupported ? (
                  <span className="text-xs text-muted-foreground">
                    {t("restore.unsupported", { engine: t(`engine.${artifact.engine}`) })}
                  </span>
                ) : null}
              </div>
            );
          })}
        </fieldset>

        {scoped ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="restore-database">{t("restore.targetDatabase")}</Label>
              <Input
                id="restore-database"
                value={database}
                onChange={(event) => setDatabase(event.target.value)}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="restore-over-existing"
                checked={overExisting}
                onChange={(event) => setOverExisting(event.target.checked)}
              />
              <Label htmlFor="restore-over-existing">{t("restore.overExisting")}</Label>
            </div>

            {overExisting ? (
              <div className="space-y-1.5">
                <p className="text-sm text-[var(--color-state-failed)]">{t("restore.confirmPrompt")}</p>
                <Label htmlFor="restore-confirm">{t("restore.confirmName")}</Label>
                <Input
                  id="restore-confirm"
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                />
                {confirmName.length > 0 && !nameMatches ? (
                  <p className="text-sm text-[var(--color-state-failed)]">{t("restore.mismatch")}</p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {restore.isError ? <ErrorState message={restore.error.message} /> : null}
        <p className="text-xs text-muted-foreground">{t("restore.serverPending")}</p>

        <div className="flex gap-2">
          <Button type="submit" variant="destructive" disabled={!canSubmit || restore.isPending}>
            {restore.isPending ? t("common.loading") : t("restore.submit")}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </div>
  );
}

// A viewer never sees the trigger. The server refuses the request regardless — this is the second
// lock, not the only one.
export function RestoreButton({ artifact, role }: { artifact: Artifact; role: Role }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!canRestore(role)) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t("artifacts.restore")}
      </Button>
      {open ? <RestoreDialog artifact={artifact} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
