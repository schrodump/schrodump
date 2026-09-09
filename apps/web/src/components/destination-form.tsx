// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { z } from "zod";
import { CredentialField } from "@/components/credential-field";
import { ErrorState } from "@/components/feedback";
import { FieldHelp, FieldLabel, FormHeader, SaveBar } from "@/components/ui/form-bits";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { useCreateDestination, useUpdateDestination } from "@/hooks/use-mutations";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import { SEAL_MODES, type SealMode } from "@/lib/domain";
import type { Destination } from "@/lib/types";

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
const sealNote: Record<SealMode, MessageKey> = {
  operational: "destinations.seal.operational",
  sealed: "destinations.seal.sealed",
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
export function DestinationForm({ onDone, destination }: { onDone: () => void; destination?: Destination }) {
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
  const [sealMode, setSealMode] = useState<SealMode>((destination?.sealMode as SealMode) ?? "operational");
  const [invalid, setInvalid] = useState(false);

  // Refused for the same reasons the API refuses, before the request — and the button says which,
  // in the order the operator would fill the form.
  const blocked: string | null =
    name.trim().length === 0
      ? t("destinations.save.blocked.name")
      : region.trim().length === 0
        ? t("destinations.save.blocked.region")
        : bucket.trim().length === 0
          ? t("destinations.save.blocked.bucket")
          : accessKeyId.trim().length === 0
            ? t("destinations.save.blocked.accessKey")
            : !editing && secretAccessKey.length === 0
              ? t("destinations.save.blocked.secret")
              : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (blocked !== null) return;

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

    const parsed = schema.safeParse({ name, region, bucket, prefix, accessKeyId, secretAccessKey, forcePathStyle, sealMode });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate({ ...parsed.data, ...(endpoint.length > 0 ? { endpoint } : {}) }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <FormHeader
        mode={t(editing ? "targets.form.modeEdit" : "targets.form.modeCreate")}
        aside={t("destinations.form.writeOnly")}
        title={t(editing ? "destinations.form.editTitle" : "destinations.form.createTitle")}
      />

      {editing ? (
        <Panel tone="lock" className="p-3.5">
          <p className="text-[12.5px] text-muted-foreground text-pretty">{t("destinations.locationLocked")}</p>
        </Panel>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="name">{t("destinations.name")}</FieldLabel>
          <Input id="name" value={name} placeholder="prod-eu-s3" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="endpoint">{t("destinations.endpoint")}</FieldLabel>
          <Input
            id="endpoint"
            value={endpoint}
            className="font-mono"
            spellCheck={false}
            placeholder={t("destinations.endpointPlaceholder")}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="region">{t("destinations.region")}</FieldLabel>
          <Input id="region" value={region} className="font-mono" placeholder="eu-central-1" onChange={(e) => setRegion(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="bucket">{t("destinations.bucket")}</FieldLabel>
          <Input id="bucket" value={bucket} className="font-mono" disabled={editing} onChange={(e) => setBucket(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="prefix">{t("destinations.prefix")}</FieldLabel>
          <Input id="prefix" value={prefix} className="font-mono" disabled={editing} onChange={(e) => setPrefix(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="sealMode">{t("destinations.sealMode")}</FieldLabel>
          <Select id="sealMode" value={sealMode} disabled={editing} onChange={(e) => setSealMode(e.target.value as SealMode)}>
            {SEAL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(sealLabel[mode])}
              </option>
            ))}
          </Select>
          <FieldHelp caution={sealMode === "sealed"}>{t(sealNote[sealMode])}</FieldHelp>
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="accessKeyId">{t("destinations.accessKeyId")}</FieldLabel>
          <Input
            id="accessKeyId"
            value={accessKeyId}
            className="font-mono"
            spellCheck={false}
            placeholder="AKIA…"
            onChange={(e) => setAccessKeyId(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <CredentialField
            id="secretAccessKey"
            label={t("destinations.secretAccessKey")}
            configured={editing}
            value={secretAccessKey}
            onChange={setSecretAccessKey}
          />
          <FieldHelp>{t(editing ? "destinations.secret.helpConfigured" : "destinations.secret.help")}</FieldHelp>
        </div>
      </div>

      <label className="flex items-start gap-3 rounded-control border border-border px-3 py-3 text-sm">
        <input type="checkbox" className="mt-0.5" checked={forcePathStyle} onChange={(e) => setForcePathStyle(e.target.checked)} />
        <span>
          <span className="block">{t("destinations.forcePathStyle")}</span>
          <span className="mt-0.5 block text-[12px] text-muted-foreground">{t("destinations.pathStyle.help")}</span>
        </span>
      </label>

      {invalid ? <p className="text-sm text-destructive-text">{t("form.invalid")}</p> : null}
      {failure !== null ? <ErrorState message={failure.message} /> : null}

      <SaveBar
        note={t(editing ? "destinations.save.noteEdit" : "destinations.save.noteCreate")}
        blocked={blocked}
        pending={pending}
        primary={t(editing ? "destinations.save.edit" : "destinations.save.create")}
        onCancel={onDone}
      />
    </form>
  );
}
