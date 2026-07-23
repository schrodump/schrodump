// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { z } from "zod";
import { useCreatePolicy } from "@/hooks/use-mutations";
import { useDestinations, useTargets } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { EXECUTION_MODES, VERIFY_LEVELS, type ExecutionMode, type VerifyLevel } from "@/lib/domain";
import type { MessageKey } from "@/i18n/messages/en";
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

export function PolicyForm({
  onDone,
  scratchConfigured,
}: {
  onDone: () => void;
  scratchConfigured: boolean;
}) {
  const t = useT();
  const targets = useTargets();
  const destinations = useDestinations();
  const create = useCreatePolicy();

  const [name, setName] = useState("");
  const [targetId, setTargetId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [cron, setCron] = useState("0 2 * * *");
  const [gfs, setGfs] = useState({ keepLast: 7, keepDaily: 0, keepWeekly: 4, keepMonthly: 6, keepYearly: 1 });
  const [verifyLevel, setVerifyLevel] = useState<VerifyLevel>("CHECKSUM");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("STREAM");
  const [parallelism, setParallelism] = useState(1);
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
          <Select id="targetId" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
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
          <Select id="destinationId" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
            <option value="" disabled />
            {(destinations.data ?? []).map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destination.name}
              </option>
            ))}
          </Select>
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
      {create.isError ? <ErrorState message={create.error.message} /> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t("common.loading") : t("common.create")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
