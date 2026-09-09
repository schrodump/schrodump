// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { ErrorState } from "@/components/feedback";
import { AcknowledgeCheckbox } from "@/components/ui/acknowledge-checkbox";
import { Button } from "@/components/ui/button";
import { DialogShell, SubjectRow } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/ui/panel";
import { RetypeToConfirm } from "@/components/ui/retype-to-confirm";
import { useTriggerRestore } from "@/hooks/use-mutations";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import {
  RESTORE_TARGETS,
  RESTORE_TARGETS_BY_ENGINE,
  canConfineRestore,
  canRestore,
  type RestoreTarget,
  type Role,
} from "@/lib/domain";
import { formatBytes } from "@/lib/format";
import type { Artifact } from "@/lib/types";

const targetLabel: Record<RestoreTarget, MessageKey> = {
  FULL_CLUSTER: "restoreTarget.FULL_CLUSTER",
  DATABASE: "restoreTarget.DATABASE",
  SCHEMA: "restoreTarget.SCHEMA",
  TABLE: "restoreTarget.TABLE",
  COLLECTION: "restoreTarget.COLLECTION",
};
const targetDescription: Record<RestoreTarget, MessageKey> = {
  FULL_CLUSTER: "restoreTarget.desc.FULL_CLUSTER",
  DATABASE: "restoreTarget.desc.DATABASE",
  SCHEMA: "restoreTarget.desc.SCHEMA",
  TABLE: "restoreTarget.desc.TABLE",
  COLLECTION: "restoreTarget.desc.COLLECTION",
};

// A restore writes real data. Scope is CHOSEN from a list, never typed; a scope the engine cannot
// restore stays on screen, disabled, with its reason. Overwriting is off by default and says what
// off means — a database that already holds data is refused, and the job says so — and turning it
// on opens a gate: retype the database's name for a scoped restore, or acknowledge that every
// database on the destination is in scope for a full-cluster one (there is no single name to
// retype). The primary action carries the reason it is blocked; it is never merely grey.
export function RestoreDialog({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const t = useT();
  const restore = useTriggerRestore();
  const supported = RESTORE_TARGETS_BY_ENGINE[artifact.engine];
  // Per-ARTIFACT, unlike `supported`, which is per-engine: the same engine restores one database
  // perfectly well when its script carries only one. A dump that carries several cannot be aimed at
  // one of them by any flag mysql provides, so every sub-cluster target is withheld with its own
  // reason rather than looking like something the engine cannot do.
  const confinable = canConfineRestore(artifact);

  const [target, setTarget] = useState<RestoreTarget>(supported[0] ?? "FULL_CLUSTER");
  const [database, setDatabase] = useState("");
  const [overExisting, setOverExisting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const scoped = target !== "FULL_CLUSTER";
  const nameMatches = database.length > 0 && confirmName === database;
  // Friction is the point: overwriting an existing database stays blocked until the operator has
  // retyped its name exactly — or, for a whole cluster, acknowledged what that means.
  const canSubmit = scoped
    ? database.length > 0 && (!overExisting || nameMatches)
    : !overExisting || acknowledged;
  const blocked = canSubmit
    ? null
    : scoped && database.length === 0
      ? t("restore.blocked.database")
      : scoped
        ? t("restore.blocked.name")
        : t("restore.blocked.ack");

  // Driven by the button's onClick, not the form's submit-on-click: a click on a type="submit"
  // button does not fire this stack's form submit (only requestSubmit does), so the restore never
  // enqueued. onSubmit is kept for Enter in the fields.
  function confirmRestore() {
    if (!canSubmit) return;
    restore.mutate({ artifactId: artifact.id, target, confirmExistingDatabase: overExisting });
  }

  const engineLine = `${t(`engine.${artifact.engine}`)} / ${t(`executionMode.${artifact.executionMode}`)}`;
  const settled = restore.isPending || restore.isSuccess;

  return (
    <DialogShell
      titleId="restore-title"
      title={t("restore.title")}
      description={t("restore.description")}
      subject={
        <SubjectRow
          state={artifact.state}
          name={artifact.targetName ?? engineLine}
          facts={[
            ...(artifact.targetName !== null ? [engineLine] : []),
            formatBytes(artifact.sizeCompressedBytes),
            artifact.id.slice(0, 8),
          ]}
        />
      }
      actions={
        <>
          <Button type="button" variant="quiet" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant={overExisting ? "danger" : "primary"}
            onClick={confirmRestore}
            disabled={settled}
            disabledReason={settled ? null : blocked}
          >
            {restore.isPending ? t("common.loading") : t("restore.submit")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          confirmRestore();
        }}
        className="space-y-4"
      >
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
            {t("restore.scope")}
          </legend>
          {RESTORE_TARGETS.map((option) => {
            const isSupported = supported.includes(option);
            const unconfinable = !confinable && option !== "FULL_CLUSTER";
            const available = isSupported && !unconfinable;
            const selected = target === option;
            return (
              <div
                key={option}
                className={cn(
                  "flex items-start gap-3 rounded-control border px-3 py-2.5",
                  selected ? "border-accent-border bg-accent-soft" : "border-border",
                  !available && "opacity-70",
                )}
              >
                <input
                  type="radio"
                  id={`target-${option}`}
                  name="restore-target"
                  value={option}
                  checked={selected}
                  disabled={!available}
                  onChange={() => setTarget(option)}
                  className="mt-1"
                />
                <div className="min-w-0">
                  <Label
                    htmlFor={`target-${option}`}
                    className={cn("block", available ? "" : "text-muted-foreground")}
                  >
                    {t(targetLabel[option])}
                  </Label>
                  {/* The reason a scope is withheld sits on its row: the engine's, or — for a dump
                      that carries several databases — the artifact's own. */}
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {!isSupported
                      ? t("restore.unsupported", { engine: t(`engine.${artifact.engine}`) })
                      : unconfinable
                        ? t("restore.notConfinable")
                        : t(targetDescription[option])}
                  </p>
                </div>
              </div>
            );
          })}
        </fieldset>

        {scoped ? (
          <div className="space-y-1.5">
            <Label htmlFor="restore-database">{t("restore.targetDatabase")}</Label>
            <Input
              id="restore-database"
              value={database}
              className="font-mono"
              spellCheck={false}
              onChange={(event) => setDatabase(event.target.value)}
            />
          </div>
        ) : null}

        <Panel tone={overExisting ? "danger" : "info"} className="p-3.5">
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              id="restore-over-existing"
              checked={overExisting}
              onChange={(event) => setOverExisting(event.target.checked)}
              className="mt-1"
            />
            <div>
              <Label htmlFor="restore-over-existing" className="block">
                {t("restore.overExisting")}
              </Label>
              <p
                className={cn(
                  "mt-1 text-[12.5px]",
                  overExisting ? "text-destructive-text" : "text-muted-foreground",
                )}
              >
                {overExisting ? t("restore.overOn") : t("restore.overOff")}
              </p>
            </div>
          </div>
        </Panel>

        {overExisting && scoped ? (
          <RetypeToConfirm
            id="restore-confirm"
            label={t("restore.confirmName")}
            hint={t("restore.confirmPrompt")}
            subject={database}
            value={confirmName}
            onChange={setConfirmName}
            mismatch={t("restore.mismatch")}
          />
        ) : null}
        {overExisting && !scoped ? (
          <AcknowledgeCheckbox checked={acknowledged} onChange={setAcknowledged}>
            {t("restore.ackFullCluster")}
          </AcknowledgeCheckbox>
        ) : null}

        {restore.isError ? <ErrorState message={restore.error.message} /> : null}
        {restore.isSuccess ? (
          <p role="status" className="text-sm text-state-verified">
            {t("restore.enqueued")}
          </p>
        ) : null}
      </form>
    </DialogShell>
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
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t("artifacts.restore")}
      </Button>
      {open ? <RestoreDialog artifact={artifact} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
