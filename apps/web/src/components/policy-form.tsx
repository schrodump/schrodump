// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { z } from "zod";
import { useCreatePolicy, useUpdatePolicy } from "@/hooks/use-mutations";
import { useDestinations, useTargets } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { EXECUTION_MODES, VERIFY_LEVELS, type ExecutionMode, type VerifyLevel } from "@/lib/domain";
import type { MessageKey } from "@/i18n/messages/en";
import type { Policy } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

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
const modeLabel: Record<ExecutionMode, MessageKey> = {
  STREAM: "executionMode.STREAM",
  STAGED: "executionMode.STAGED",
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

  function onSubmit(event: FormEvent) {
    event.preventDefault();
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
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">{t("policies.name")}</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cron">{t("policies.cron")}</Label>
          <Input id="cron" value={cron} onChange={(e) => setCron(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="targetId">{t("policies.target")}</Label>
          <Select
            id="targetId"
            value={targetId}
            disabled={editing}
            onChange={(e) => setTargetId(e.target.value)}
          >
            <option value="" disabled />
            {(targets.data ?? []).map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="destinationId">{t("policies.destination")}</Label>
          <Select
            id="destinationId"
            value={destinationId}
            disabled={editing}
            onChange={(e) => setDestinationId(e.target.value)}
          >
            <option value="" disabled />
            {(destinations.data ?? []).map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destination.name}
              </option>
            ))}
          </Select>
          {editing ? <p className="text-xs text-muted-foreground">{t("policies.repointLocked")}</p> : null}
        </div>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-5">
        <legend className="mb-1 text-sm font-medium sm:col-span-5">{t("policies.retention")}</legend>
        {GFS_FIELDS.map((field) => (
          <div key={field.name} className="space-y-1.5">
            <Label htmlFor={field.name}>{t(field.key)}</Label>
            <Input
              id={field.name}
              type="number"
              min={0}
              value={gfs[field.name]}
              onChange={(e) => setGfs((prev) => ({ ...prev, [field.name]: Number(e.target.value) }))}
            />
          </div>
        ))}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="verifyLevel">{t("policies.verifyLevel")}</Label>
          <Select id="verifyLevel" value={verifyLevel} onChange={(e) => setVerifyLevel(e.target.value as VerifyLevel)}>
            {VERIFY_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(verifyLabel[level])}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="executionMode">{t("policies.executionMode")}</Label>
          <Select id="executionMode" value={executionMode} onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}>
            {EXECUTION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(modeLabel[mode])}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="parallelism">{t("policies.parallelism")}</Label>
          <Input
            id="parallelism"
            type="number"
            min={1}
            value={scratchConfigured ? parallelism : 1}
            disabled={!scratchConfigured}
            onChange={(e) => setParallelism(Number(e.target.value))}
          />
          {!scratchConfigured ? (
            <p className="text-xs text-muted-foreground">{t("policies.parallelism.disabled")}</p>
          ) : null}
        </div>
      </div>

      {invalid ? <p className="text-sm text-[var(--color-state-failed)]">{t("form.invalid")}</p> : null}
      {failure !== null ? <ErrorState message={failure.message} /> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? t("common.loading") : editing ? t("common.save") : t("common.create")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
