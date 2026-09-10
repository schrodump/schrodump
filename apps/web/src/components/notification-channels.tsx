// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { ErrorState } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FieldHelp, FieldLabel, FormHeader, SaveBar } from "@/components/ui/form-bits";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import {
  useCreateNotificationChannel,
  useDeleteNotificationChannel,
  useSetNotificationChannelEnabled,
} from "@/hooks/use-mutations";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/format";
import type { NotificationChannel, NotificationChannelKind } from "@/lib/types";

// Mirrors the server's schema, which refuses anything shorter. Stated here so the rule is read
// before the secret is typed rather than discovered in a 400 afterwards — and named, so the two
// numbers cannot drift apart silently.
const MIN_SECRET_LENGTH = 16;

// The port field shows 587 as a PLACEHOLDER, not a value: untouched it means "use the default",
// emptied it means the operator deleted it. Number("") is 0, which the server rightly refuses as
// not positive, so the two cases have to be told apart here rather than collapsed by a ?? that
// only catches undefined.
const DEFAULT_SMTP_PORT = 587;

export const CHANNEL_ROW_GRID = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[10rem_minmax(0,1fr)_auto]";

export function ChannelRow({ channel, canEdit }: { channel: NotificationChannel; canEdit: boolean }) {
  const t = useT();
  const setEnabled = useSetNotificationChannelEnabled();
  const remove = useDeleteNotificationChannel();
  const [confirming, setConfirming] = useState(false);
  const where = channel.kind === "WEBHOOK" ? channel.url : channel.toAddresses.join(", ");
  const failing = channel.lastFailure !== null;

  return (
    <div className="border-b border-border">
      <div className={cn("grid items-start gap-x-4 gap-y-2 px-[18px] py-3", CHANNEL_ROW_GRID)}>
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">
            {channel.kind === "WEBHOOK" ? t("notifications.kind.webhook") : t("notifications.kind.smtp")}
          </div>
          {!channel.enabled ? (
            <span className="mt-1 inline-block rounded-sm border border-border-region bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-[0.13em] uppercase text-muted-foreground">
              {t("notifications.disabled")}
            </span>
          ) : null}
        </div>
        <div className="min-w-0 font-mono text-[12px] text-muted-foreground break-all">{where}</div>
        {canEdit ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button
              size="sm"
              variant="quiet"
              disabled={setEnabled.isPending}
              onClick={() => setEnabled.mutate({ id: channel.id, enabled: !channel.enabled })}
            >
              {channel.enabled ? t("notifications.disable") : t("notifications.enable")}
            </Button>
            <Button size="sm" variant="ghost" disabled={confirming} onClick={() => setConfirming(true)}>
              {t("common.delete")}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Surfaced, never swallowed: a notifier nobody can tell is broken is worse than none. */}
      {failing ? (
        <div className="px-[18px] pb-3">
          <Panel tone="error" className="p-3">
            <p className="text-[12.5px]">{t("notifications.lastFailure", { reason: channel.lastFailure ?? "" })}</p>
            {channel.lastFailureAt !== null ? (
              <p className="mt-1 font-mono text-[11px] text-subtle-foreground">{formatRelative(channel.lastFailureAt)}</p>
            ) : null}
          </Panel>
        </div>
      ) : null}
      {setEnabled.isError ? (
        <div className="px-[18px] pb-3">
          <ErrorState message={setEnabled.error.message} />
        </div>
      ) : null}

      {confirming ? (
        <div className="px-[18px] pb-3">
          {/* Deleting a channel that is recording failures throws away the only evidence it was
              failing, so the reversible operation is offered right there. */}
          <Panel tone={failing ? "warning" : "danger"} className="flex flex-wrap items-center gap-3 p-3.5">
            <span className="min-w-0 flex-1 text-[12.5px]">
              {t(failing ? "notifications.delete.failing" : "notifications.delete.plain")}
            </span>
            <Button type="button" size="sm" variant="quiet" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            {channel.enabled ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={setEnabled.isPending}
                onClick={() => setEnabled.mutate({ id: channel.id, enabled: false }, { onSuccess: () => setConfirming(false) })}
              >
                {t("notifications.delete.disableInstead")}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(channel.id)}>
              {remove.isPending ? t("common.loading") : t("notifications.delete.submit")}
            </Button>
          </Panel>
          {remove.isError ? (
            <div className="mt-2">
              <ErrorState message={`${t("config.refused")} — ${remove.error.message}`} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ChannelForm() {
  const t = useT();
  const create = useCreateNotificationChannel();
  const [kind, setKind] = useState<NotificationChannelKind>("WEBHOOK");
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (key: string) => (event: { target: { value: string } }) =>
    setFields((previous) => ({ ...previous, [key]: event.target.value }));
  const value = (key: string) => fields[key] ?? "";

  const port = fields.smtpPort === undefined ? DEFAULT_SMTP_PORT : Number(fields.smtpPort);
  const portIsUsable = Number.isInteger(port) && port > 0;

  const recipients = value("toAddresses")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const blocked: string | null =
    kind === "WEBHOOK"
      ? value("url").trim().length === 0
        ? t("notifications.save.blocked.url")
        : value("secret").length === 0
          ? t("notifications.save.blocked.secret")
          : value("secret").length < MIN_SECRET_LENGTH
            ? t("notifications.save.blocked.secretShort", { min: String(MIN_SECRET_LENGTH) })
            : null
      : value("smtpHost").trim().length === 0 ||
          value("smtpUsername").trim().length === 0 ||
          value("smtpPassword").length === 0 ||
          value("fromAddress").trim().length === 0
        ? t("notifications.save.blocked.smtp")
        : !portIsUsable
          ? t("notifications.save.blocked.port")
          : recipients.length === 0
            ? t("notifications.save.blocked.recipients")
            : null;

  function submit(): void {
    if (blocked !== null) return;
    // Built key by key rather than spreading the form state: the server's schema is a strict
    // discriminated union, so a stray field from the other kind is a 400 — and, more to the point,
    // a channel that is half webhook and half email is not a thing that should be expressible.
    const body =
      kind === "WEBHOOK"
        ? { kind, url: value("url"), secret: value("secret") }
        : {
            kind,
            smtpHost: value("smtpHost"),
            smtpPort: port,
            smtpUsername: value("smtpUsername"),
            smtpPassword: value("smtpPassword"),
            fromAddress: value("fromAddress"),
            toAddresses: recipients,
          };
    create.mutate(body, { onSuccess: () => setFields({}) });
  }

  const field = (key: string, label: string, opts: { type?: string; placeholder?: string; mono?: boolean } = {}) => (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={`channel-${key}`}>{label}</FieldLabel>
      <Input
        id={`channel-${key}`}
        type={opts.type ?? "text"}
        autoComplete={opts.type === "password" ? "new-password" : "off"}
        spellCheck={false}
        placeholder={opts.placeholder}
        className={opts.mono === false ? undefined : "font-mono"}
        value={value(key)}
        onChange={set(key)}
      />
    </div>
  );

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <FormHeader mode={t("targets.form.modeCreate")} aside={t("notifications.form.writeOnly")} title={t("notifications.form.title")} />

      <div className="space-y-1.5 sm:max-w-xs">
        <FieldLabel htmlFor="channel-kind">{t("notifications.kind")}</FieldLabel>
        <Select id="channel-kind" value={kind} onChange={(event) => setKind(event.target.value as NotificationChannelKind)}>
          <option value="WEBHOOK">{t("notifications.kind.webhook")}</option>
          <option value="SMTP">{t("notifications.kind.smtp")}</option>
        </Select>
      </div>

      {kind === "WEBHOOK" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {field("url", t("notifications.url"), { placeholder: "https://hooks.company.example/schrodump" })}
          <div className="space-y-1.5">
            {field("secret", t("notifications.secret"), { type: "password" })}
            <FieldHelp>{t("notifications.secret.hint", { min: String(MIN_SECRET_LENGTH) })}</FieldHelp>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {field("smtpHost", t("notifications.smtp.host"), { placeholder: "smtp.company.example" })}
            {field("smtpPort", t("notifications.smtp.port"), { placeholder: "587" })}
            {field("smtpUsername", t("notifications.smtp.username"))}
            {field("smtpPassword", t("notifications.smtp.password"), { type: "password" })}
            {field("fromAddress", t("notifications.from"), { placeholder: "schrodump@company.example" })}
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="channel-toAddresses">{t("notifications.to")}</FieldLabel>
            <textarea
              id="channel-toAddresses"
              rows={3}
              spellCheck={false}
              className="w-full rounded-control border border-border bg-background px-3 py-2 font-mono text-[12.5px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-accent-soft"
              value={value("toAddresses")}
              onChange={set("toAddresses")}
            />
          </div>
          <FieldHelp>{t("notifications.tls")}</FieldHelp>
        </div>
      )}

      {create.isError ? <ErrorState message={create.error.message} /> : null}

      <SaveBar note={t("notifications.save.note")} blocked={blocked} pending={create.isPending} primary={t("notifications.create")} />
    </form>
  );
}
