// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { z } from "zod";
import { ErrorState } from "@/components/feedback";
import { CronReading } from "@/components/cron-reading";
import { FieldHelp, FieldLabel, FormHeader, SaveBar, SectionLabel } from "@/components/ui/form-bits";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { useCreatePolicy, useUpdatePolicy } from "@/hooks/use-mutations";
import { useDestinations, useTargets } from "@/hooks/use-resources";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import { parseCron } from "@/lib/cron";
import { EXECUTION_MODES, VERIFY_LEVELS, type ExecutionMode, type VerifyLevel } from "@/lib/domain";
import type { Policy } from "@/lib/types";

const schema = z.object({
  name: z.string().min(1),
  targetId: z.string().min(1),
  destinationId: z.string().min(1),
  cron: z.string().min(1),
  keepLast: z.number().int().min(0),
  keepDaily: z.number().int().min(0),
  keepWeekly: z.number().int().min(0),
  keepMonthly: z.number().int().min(0),
  keepYearly: z.number().int().min(0),
  verifyLevel: z.enum(VERIFY_LEVELS),
  executionMode: z.enum(EXECUTION_MODES),
  parallelism: z.number().int().min(1),
});

const GFS_FIELDS = [
  { name: "keepLast", key: "policies.keepLast" },
  { name: "keepDaily", key: "policies.keepDaily" },
  { name: "keepWeekly", key: "policies.keepWeekly" },
  { name: "keepMonthly", key: "policies.keepMonthly" },
  { name: "keepYearly", key: "policies.keepYearly" },
] as const satisfies readonly { name: string; key: MessageKey }[];

const verifyLabel: Record<VerifyLevel, MessageKey> = {
  NONE: "verifyLevel.NONE",
  CHECKSUM: "verifyLevel.CHECKSUM",
  FULL_RESTORE: "verifyLevel.FULL_RESTORE",
};
const verifyMeaning: Record<VerifyLevel, MessageKey> = {
  NONE: "policies.verify.meaning.NONE",
  CHECKSUM: "policies.verify.meaning.CHECKSUM",
  FULL_RESTORE: "policies.verify.meaning.FULL_RESTORE",
};
const modeLabel: Record<ExecutionMode, MessageKey> = {
  STREAM: "executionMode.STREAM",
  STAGED: "executionMode.STAGED",
};
const modeMeaning: Record<ExecutionMode, MessageKey> = {
  STREAM: "policies.mode.STREAM",
  STAGED: "policies.mode.STAGED",
};

// `policy` present switches the form to edit mode. The target and destination stay visible but
// locked: retention reasons per policy, so repointing either would fold two databases into one GFS
// chain and strand the artifacts already written to the old destination outside retention forever.
// The server refuses those two fields outright; showing them disabled with the reason is clearer
// than hiding what the policy is actually pointed at.
export function PolicyForm({
  onDone,
  scratchConfigured,
  policy,
}: {
  onDone: () => void;
  scratchConfigured: boolean;
  policy?: Policy;
}) {
  const t = useT();
  const targets = useTargets();
  const destinations = useDestinations();
  const create = useCreatePolicy();
  const update = useUpdatePolicy();
  const editing = policy !== undefined;
  const pending = editing ? update.isPending : create.isPending;
  const failure = editing ? update.error : create.error;

  const [name, setName] = useState(policy?.name ?? "");
  const [targetId, setTargetId] = useState(policy?.targetId ?? "");
  const [destinationId, setDestinationId] = useState(policy?.destinationId ?? "");
  const [cron, setCron] = useState(policy?.cron ?? "0 2 * * *");
  const [gfs, setGfs] = useState(
    policy !== undefined
      ? {
          keepLast: policy.keepLast,
          keepDaily: policy.keepDaily,
          keepWeekly: policy.keepWeekly,
          keepMonthly: policy.keepMonthly,
          keepYearly: policy.keepYearly,
        }
      : { keepLast: 7, keepDaily: 0, keepWeekly: 4, keepMonthly: 6, keepYearly: 1 },
  );
  const [verifyLevel, setVerifyLevel] = useState<VerifyLevel>(policy?.verifyLevel ?? "CHECKSUM");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(policy?.executionMode ?? "STREAM");
  const [parallelism, setParallelism] = useState(policy?.parallelism ?? 1);
  const [invalid, setInvalid] = useState(false);

  const destination = (destinations.data ?? []).find((d) => d.id === destinationId);
  const sealedFullRestore = verifyLevel === "FULL_RESTORE" && destination?.sealMode === "sealed";
  const retainsNothing = Object.values(gfs).every((n) => n === 0);

  const blocked: string | null =
    name.trim().length === 0
      ? t("policies.save.blocked.name")
      : targetId.length === 0
        ? t("policies.save.blocked.target")
        : destinationId.length === 0
          ? t("policies.save.blocked.destination")
          : parseCron(cron) === null
            ? t("policies.save.blocked.cron")
            : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (blocked !== null) return;
    const parsed = schema.safeParse({
      name,
      targetId,
      destinationId,
      cron,
      ...gfs,
      verifyLevel,
      executionMode,
      parallelism: scratchConfigured ? parallelism : 1,
    });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (policy !== undefined) {
      // Listed field by field rather than spread-minus-two: the PATCH schema is .strict(), so
      // sending targetId or destinationId is a 400, and an allow-list cannot leak a new field into
      // the body the day one is added to the create schema.
      update.mutate(
        {
          id: policy.id,
          body: {
            name: parsed.data.name,
            cron: parsed.data.cron,
            keepLast: parsed.data.keepLast,
            keepDaily: parsed.data.keepDaily,
            keepWeekly: parsed.data.keepWeekly,
            keepMonthly: parsed.data.keepMonthly,
            keepYearly: parsed.data.keepYearly,
            verifyLevel: parsed.data.verifyLevel,
            executionMode: parsed.data.executionMode,
            parallelism: parsed.data.parallelism,
          },
        },
        { onSuccess: onDone },
      );
      return;
    }
    create.mutate({ ...parsed.data, minAgeBeforeDeleteMs: 0 }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <FormHeader
        mode={t(editing ? "targets.form.modeEdit" : "targets.form.modeCreate")}
        aside={t("policies.form.perPolicy")}
        title={t(editing ? "policies.form.editTitle" : "policies.form.createTitle")}
      />

      {editing ? (
        <Panel tone="lock" className="p-3.5">
          <p className="text-[12.5px] text-muted-foreground text-pretty">{t("policies.repointLocked")}</p>
        </Panel>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="name">{t("policies.name")}</FieldLabel>
          <Input id="name" value={name} placeholder="nightly-eu" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="cron">{t("policies.cron")}</FieldLabel>
          <Input id="cron" value={cron} className="font-mono" spellCheck={false} onChange={(e) => setCron(e.target.value)} />
          <CronReading cron={cron} enabled className="text-[12px]" />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="targetId">{t("policies.target")}</FieldLabel>
          <Select id="targetId" value={targetId} disabled={editing} onChange={(e) => setTargetId(e.target.value)}>
            <option value="" disabled />
            {(targets.data ?? []).map((target) => (
              <option key={target.id} value={target.id}>
                {t("policies.targetOption", { name: target.name, engine: t(`engine.${target.engine}`) })}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="destinationId">{t("policies.destination")}</FieldLabel>
          <Select id="destinationId" value={destinationId} disabled={editing} onChange={(e) => setDestinationId(e.target.value)}>
            <option value="" disabled />
            {(destinations.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {t("policies.destinationOption", { name: d.name, seal: t(`sealMode.${d.sealMode}`) })}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-1">
          <SectionLabel>{t("policies.retention")}</SectionLabel>
        </legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {GFS_FIELDS.map((field) => (
            <div key={field.name} className="space-y-1.5">
              <FieldLabel htmlFor={field.name}>{t(field.key)}</FieldLabel>
              <Input
                id={field.name}
                type="number"
                min={0}
                className="font-mono"
                value={gfs[field.name]}
                onChange={(e) => setGfs((prev) => ({ ...prev, [field.name]: Number(e.target.value) }))}
              />
            </div>
          ))}
        </div>
        <FieldHelp caution={retainsNothing}>{t("policies.retention.zeroNote")}</FieldHelp>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="verifyLevel">{t("policies.verifyLevel")}</FieldLabel>
          <Select id="verifyLevel" value={verifyLevel} onChange={(e) => setVerifyLevel(e.target.value as VerifyLevel)}>
            {VERIFY_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(verifyLabel[level])}
              </option>
            ))}
          </Select>
          <FieldHelp caution={verifyLevel === "NONE"}>{t(verifyMeaning[verifyLevel])}</FieldHelp>
          {sealedFullRestore ? (
            <Panel tone="warning" className="p-3">
              <p className="text-[12px] text-pretty">{t("policies.verify.sealedCaution")}</p>
            </Panel>
          ) : null}
          {verifyLevel === "FULL_RESTORE" && !scratchConfigured ? (
            <Panel tone="warning" className="p-3">
              <p className="text-[12px] text-pretty">{t("policies.verify.noScratch")}</p>
            </Panel>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="executionMode">{t("policies.executionMode")}</FieldLabel>
          <Select id="executionMode" value={executionMode} onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}>
            {EXECUTION_MODES.map((mode) => (
              <option key={mode} value={mode} disabled={mode === "STAGED" && !scratchConfigured}>
                {t(modeLabel[mode])}
              </option>
            ))}
          </Select>
          <FieldHelp>{t(modeMeaning[executionMode])}</FieldHelp>
          {!scratchConfigured ? <FieldHelp caution>{t("policies.mode.stagedNoScratch")}</FieldHelp> : null}
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="parallelism">{t("policies.parallelism")}</FieldLabel>
          <Input
            id="parallelism"
            type="number"
            min={1}
            className="font-mono"
            value={scratchConfigured ? parallelism : 1}
            disabled={!scratchConfigured}
            onChange={(e) => setParallelism(Number(e.target.value))}
          />
          {!scratchConfigured ? <FieldHelp caution>{t("policies.parallelism.disabled")}</FieldHelp> : null}
        </div>
      </div>

      {invalid ? <p className="text-sm text-destructive-text">{t("form.invalid")}</p> : null}
      {failure !== null ? <ErrorState message={failure.message} /> : null}

      <SaveBar
        note={t("policies.save.note")}
        blocked={blocked}
        pending={pending}
        primary={t(editing ? "policies.save.edit" : "policies.save.create")}
        onCancel={onDone}
      />
    </form>
  );
}
