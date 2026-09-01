// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { ErrorState, EmptyState, LoadingState } from "@/components/feedback";
import { ChannelForm, ChannelRow } from "@/components/notification-channels";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useNotificationChannels } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";

export default function NotificationsPage() {
  const t = useT();
  const channels = useNotificationChannels();
  // Fails closed to viewer while the role loads, like every other gated control. The server
  // enforces operator+ independently; this is UX, not the control.
  const canEdit = useCurrentRole() !== "viewer";

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">{t("notifications.title")}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t("notifications.subtitle")}</p>

      {channels.isPending ? <LoadingState /> : null}
      {channels.isError ? <ErrorState message={channels.error.message} /> : null}
      {channels.isSuccess && channels.data.length === 0 ? (
        <EmptyState message={t("notifications.empty")} />
      ) : null}

      <div className="flex flex-col gap-3">
        {(channels.data ?? []).map((channel) => (
          <ChannelRow key={channel.id} channel={channel} canEdit={canEdit} />
        ))}
      </div>

      {canEdit ? (
        <div className="mt-6">
          <ChannelForm />
        </div>
      ) : null}
    </AppShell>
  );
}
