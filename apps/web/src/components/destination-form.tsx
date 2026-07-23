// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { z } from "zod";
import { useCreateDestination } from "@/hooks/use-mutations";
import { useT } from "@/i18n/provider";
import { SEAL_MODES, type SealMode } from "@/lib/domain";
import type { MessageKey } from "@/i18n/messages/en";
import { Button } from "@/components/ui/button";
import { CredentialField } from "@/components/credential-field";
import { ErrorState } from "@/components/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

const schema = z.object({
  name: z.string().min(1),
  region: z.string().min(1),
  bucket: z.string().min(1),
  prefix: z.string(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean(),
  sealMode: z.enum(SEAL_MODES),
});

const sealLabel: Record<SealMode, MessageKey> = {
  operational: "sealMode.operational",
  sealed: "sealMode.sealed",
};

export function DestinationForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const create = useCreateDestination();
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [sealMode, setSealMode] = useState<SealMode>("operational");
  const [invalid, setInvalid] = useState(false);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = schema.safeParse({
      name,
      region,
      bucket,
      prefix,
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      sealMode,
    });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(
      { ...parsed.data, ...(endpoint.length > 0 ? { endpoint } : {}) },
      { onSuccess: onDone },
    );
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="name">{t("destinations.name")}</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="endpoint">{t("destinations.endpoint")}</Label>
        <Input id="endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="region">{t("destinations.region")}</Label>
        <Input id="region" value={region} onChange={(e) => setRegion(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="bucket">{t("destinations.bucket")}</Label>
        <Input id="bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="prefix">{t("destinations.prefix")}</Label>
        <Input id="prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="accessKeyId">{t("destinations.accessKeyId")}</Label>
        <Input id="accessKeyId" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
      </div>
      <CredentialField
        id="secretAccessKey"
        label={t("destinations.secretAccessKey")}
        configured={false}
        value={secretAccessKey}
        onChange={setSecretAccessKey}
      />
      <div className="space-y-1.5">
        <Label htmlFor="sealMode">{t("destinations.sealMode")}</Label>
        <Select id="sealMode" value={sealMode} onChange={(e) => setSealMode(e.target.value as SealMode)}>
          {SEAL_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(sealLabel[mode])}
            </option>
          ))}
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={forcePathStyle}
          onChange={(e) => setForcePathStyle(e.target.checked)}
        />
        {t("destinations.forcePathStyle")}
      </label>
      <div className="sm:col-span-2 space-y-2">
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
      </div>
    </form>
  );
}
