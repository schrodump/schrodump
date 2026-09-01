// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { z } from "zod";
import { useCreateDestination, useUpdateDestination } from "@/hooks/use-mutations";
import { useT } from "@/i18n/provider";
import { SEAL_MODES, type SealMode } from "@/lib/domain";
import type { MessageKey } from "@/i18n/messages/en";
import type { Destination } from "@/lib/types";
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

// The subset a PATCH may carry. bucket/prefix/sealMode are absent because the server refuses
// them: artifact keys are stored relative to bucket+prefix, so repointing either leaves the whole
// catalogue describing addresses that hold nothing, and sealMode is a crypto-posture change.
const patchSchema = z.object({
  name: z.string().min(1),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  forcePathStyle: z.boolean(),
});

// `destination` present switches the form to edit mode. The locked fields stay visible rather than
// hidden — what a destination points at is the thing an operator most needs to read.
export function DestinationForm({
  onDone,
  destination,
}: {
  onDone: () => void;
  destination?: Destination;
}) {
  const t = useT();
  const create = useCreateDestination();
  const update = useUpdateDestination();
  const editing = destination !== undefined;
  const pending = editing ? update.isPending : create.isPending;
  const failure = editing ? update.error : create.error;

  const [name, setName] = useState(destination?.name ?? "");
  const [endpoint, setEndpoint] = useState(destination?.endpoint ?? "");
  const [region, setRegion] = useState(destination?.region ?? "");
  const [bucket, setBucket] = useState(destination?.bucket ?? "");
  const [prefix, setPrefix] = useState(destination?.prefix ?? "");
  const [accessKeyId, setAccessKeyId] = useState(destination?.accessKeyId ?? "");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [forcePathStyle, setForcePathStyle] = useState(destination?.forcePathStyle ?? false);
  const [sealMode, setSealMode] = useState<SealMode>(
    (destination?.sealMode as SealMode) ?? "operational",
  );
  const [invalid, setInvalid] = useState(false);

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (destination !== undefined) {
      const parsed = patchSchema.safeParse({ name, region, accessKeyId, forcePathStyle });
      if (!parsed.success) {
        setInvalid(true);
        return;
      }
      setInvalid(false);
      // An empty secret field means "leave the stored one alone" — the only way to edit a region
      // when the UI can never read the secret back to re-submit it. Sending "" would be a 400.
      update.mutate(
        {
          id: destination.id,
          body: {
            ...parsed.data,
            ...(endpoint.length > 0 ? { endpoint } : {}),
            ...(secretAccessKey.length > 0 ? { secretAccessKey } : {}),
          },
        },
        { onSuccess: onDone },
      );
      return;
    }

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
        <Input
          id="bucket"
          value={bucket}
          disabled={editing}
          onChange={(e) => setBucket(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="prefix">{t("destinations.prefix")}</Label>
        <Input
          id="prefix"
          value={prefix}
          disabled={editing}
          onChange={(e) => setPrefix(e.target.value)}
        />
        {editing ? (
          <p className="text-xs text-muted-foreground">{t("destinations.locationLocked")}</p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="accessKeyId">{t("destinations.accessKeyId")}</Label>
        <Input
          id="accessKeyId"
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
        />
      </div>
      <CredentialField
        id="secretAccessKey"
        label={t("destinations.secretAccessKey")}
        configured={editing}
        value={secretAccessKey}
        onChange={setSecretAccessKey}
      />
      <div className="space-y-1.5">
        <Label htmlFor="sealMode">{t("destinations.sealMode")}</Label>
        <Select
          id="sealMode"
          value={sealMode}
          disabled={editing}
          onChange={(e) => setSealMode(e.target.value as SealMode)}
        >
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
        {invalid ? (
          <p className="text-sm text-[var(--color-state-failed)]">{t("form.invalid")}</p>
        ) : null}
        {failure !== null ? <ErrorState message={failure.message} /> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? t("common.loading") : editing ? t("common.save") : t("common.create")}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </form>
  );
}
