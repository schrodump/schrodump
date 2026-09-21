// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { ErrorState } from "@/components/feedback";
import { AcknowledgeCheckbox } from "@/components/ui/acknowledge-checkbox";
import { Button } from "@/components/ui/button";
import { DialogShell, SubjectRow } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/ui/panel";
import { RetypeToConfirm } from "@/components/ui/retype-to-confirm";
import { useTriggerRestore } from "@/hooks/use-mutations";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import {
  RESTORE_TARGETS,
  canRestore,
  restoreScopeBlocker,
  type RestoreScopeBlocker,
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
// The reason a scope is withheld sits on its row. "unsupported" is the engine's; every other one is
// this artifact's or its target's, and says so — an operator told "not supported" would stop looking.
const blockerReason: Record<Exclude<RestoreScopeBlocker, "unsupported">, MessageKey> = {
  notConfinable: "restore.notConfinable",
  noTarget: "restore.noTarget",
  needsDatabase: "restore.needsDatabase",
  needsSchema: "restore.needsSchema",
  needsTable: "restore.needsTable",
  needsCollection: "restore.needsCollection",
};

// A restore writes real data. Scope is CHOSEN from a list, never typed; a scope that cannot run
// stays on screen, disabled, with its reason. The dialog says WHERE the restore writes — the
// producing policy's target, host, port and database — because the server restores there and
// nowhere else: an earlier version collected a "target database" the request never carried, so a
// name typed as a scratch copy and retyped to confirm an overwrite pointed the operator at one
// database while the worker wrote over production. Overwriting is off by default and says what off
// means; turning it on opens a gate: retype the name of the database that will actually be
// overwritten, or, for a full-cluster restore, acknowledge that every database on the destination
// is in scope. The primary action carries the reason it is blocked; it is never merely grey.
export function RestoreDialog({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const t = useT();
  const restore = useTriggerRestore();
  const into = artifact.restoreInto;
  const blockerOf = (option: RestoreTarget) => restoreScopeBlocker(artifact, option);

  const [target, setTarget] = useState<RestoreTarget>(
    () => RESTORE_TARGETS.find((option) => blockerOf(option) === null) ?? "FULL_CLUSTER",
  );
  const [overExisting, setOverExisting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const scoped = target !== "FULL_CLUSTER";
  // A scoped option is only selectable when the target names its database, so this is never empty
  // for a scoped restore; the empty fallback keeps an impossible state from matching an empty retype.
  const database = into?.database ?? "";
  const nameMatches = database.length > 0 && confirmName === database;
  // Friction is the point: overwriting an existing database stays blocked until the operator has
  // retyped its name exactly — or, for a whole cluster, acknowledged what that means.
  const reachable = into !== null && blockerOf(target) === null;
  const canSubmit = reachable && (scoped ? !overExisting || nameMatches : !overExisting || acknowledged);
  const blocked = canSubmit
    ? null
    : into === null
      ? t("restore.blocked.noTarget")
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
            const blocker = blockerOf(option);
            const available = blocker === null;
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
                  {/* The reason a scope is withheld sits on its row: the engine's, or the
                      artifact's and its target's own. */}
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {blocker === null
                      ? t(targetDescription[option])
                      : blocker === "unsupported"
                        ? t("restore.unsupported", { engine: t(`engine.${artifact.engine}`) })
                        : t(blockerReason[blocker])}
                  </p>
                </div>
              </div>
            );
          })}
        </fieldset>

        {/* Where the restore writes. The server has exactly one answer — the producing policy's
            target — and this is it, read from the same scope the worker restores through. */}
        {into !== null ? (
          <div
            data-testid="restore-into"
            className="rounded-control border border-border-region bg-muted px-3 py-2.5"
          >
            <div className="font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
              {t("restore.into")}
            </div>
            <div className="mt-1 text-[13.5px] font-medium">{artifact.targetName}</div>
            <div className="mt-0.5 font-mono text-[12px] text-muted-foreground">
              {`${into.host}:${String(into.port)}`}
              {into.database !== null ? ` · ${t("restore.intoDatabase", { database: into.database })}` : ""}
            </div>
          </div>
        ) : (
          <Panel tone="lock" role="alert" className="p-3.5">
            <p className="text-[12.5px]">{t("restore.noTarget")}</p>
          </Panel>
        )}

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
