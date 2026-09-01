// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  useCreateNotificationChannel,
  useDeleteNotificationChannel,
  useSetNotificationChannelEnabled,
} from "@/hooks/use-mutations";
import { useT } from "@/i18n/provider";
import type { NotificationChannel, NotificationChannelKind } from "@/lib/types";

export function ChannelRow({
  channel,
  canEdit,
}: {
  channel: NotificationChannel;
  canEdit: boolean;
}) {
  const t = useT();
  const setEnabled = useSetNotificationChannelEnabled();
  const remove = useDeleteNotificationChannel();
  const where = channel.kind === "WEBHOOK" ? channel.url : channel.toAddresses.join(", ");

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">
              {channel.kind === "WEBHOOK"
                ? t("notifications.kind.webhook")
                : t("notifications.kind.smtp")}
            </span>
            {!channel.enabled ? (
              <span className="text-sm text-[var(--color-state-unobserved)]">
                {t("notifications.disabled")}
              </span>
            ) : null}
          </div>
          <p className="truncate text-sm text-muted-foreground">{where}</p>
          {/* Surfaced, never swallowed: a notifier nobody can tell is broken is worse than none. */}
          {channel.lastFailure !== null ? (
            <p className="text-sm text-[var(--color-state-failed)]">
              {t("notifications.lastFailure", { reason: channel.lastFailure })}
            </p>
          ) : null}
        </div>
        {canEdit ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={setEnabled.isPending}
              onClick={() => setEnabled.mutate({ id: channel.id, enabled: !channel.enabled })}
            >
              {channel.enabled ? t("notifications.disable") : t("notifications.enable")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate(channel.id)}
            >
              {t("common.delete")}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ChannelForm() {
  const t = useT();
  const create = useCreateNotificationChannel();
  const [kind, setKind] = useState<NotificationChannelKind>("WEBHOOK");
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (key: string) => (event: { target: { value: string } }) =>
    setFields((previous) => ({ ...previous, [key]: event.target.value }));

  const submit = (): void => {
    // Built key by key rather than spreading the form state: the server's schema is a strict
    // discriminated union, so a stray field from the other kind is a 400 — and, more to the point,
    // a channel that is half webhook and half email is not a thing that should be expressible.
    const body =
      kind === "WEBHOOK"
        ? { kind, url: fields.url ?? "", secret: fields.secret ?? "" }
        : {
            kind,
            smtpHost: fields.smtpHost ?? "",
            smtpPort: Number(fields.smtpPort ?? "587"),
            smtpUsername: fields.smtpUsername ?? "",
            smtpPassword: fields.smtpPassword ?? "",
            fromAddress: fields.fromAddress ?? "",
            toAddresses: (fields.toAddresses ?? "")
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          };
    create.mutate(body);
  };

  const field = (key: string, label: string, type = "text") => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        className="rounded border px-2 py-1"
        type={type}
        value={fields[key] ?? ""}
        onChange={set(key)}
      />
    </label>
  );

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <label className="flex flex-col gap-1 text-sm">
          {t("notifications.kind")}
          <select
            className="rounded border px-2 py-1"
            value={kind}
            onChange={(event) => setKind(event.target.value as NotificationChannelKind)}
          >
            <option value="WEBHOOK">{t("notifications.kind.webhook")}</option>
            <option value="SMTP">{t("notifications.kind.smtp")}</option>
          </select>
        </label>

        {kind === "WEBHOOK" ? (
          <>
            {field("url", t("notifications.url"))}
            {field("secret", t("notifications.secret"), "password")}
            <p className="text-sm text-muted-foreground">{t("notifications.secret.hint")}</p>
          </>
        ) : (
          <>
            {field("smtpHost", t("notifications.smtp.host"))}
            {field("smtpPort", t("notifications.smtp.port"))}
            {field("smtpUsername", t("notifications.smtp.username"))}
            {field("smtpPassword", t("notifications.smtp.password"), "password")}
            {field("fromAddress", t("notifications.from"))}
            <label className="flex flex-col gap-1 text-sm">
              {t("notifications.to")}
              <textarea
                className="rounded border px-2 py-1"
                rows={3}
                value={fields.toAddresses ?? ""}
                onChange={set("toAddresses")}
              />
            </label>
            <p className="text-sm text-muted-foreground">{t("notifications.tls")}</p>
          </>
        )}

        <div>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? t("common.loading") : t("notifications.create")}
          </Button>
        </div>
        {create.isError ? (
          <p className="text-sm text-[var(--color-state-failed)]">{create.error.message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
