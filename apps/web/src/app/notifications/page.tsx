// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback";
import { CHANNEL_ROW_GRID, ChannelForm, ChannelRow } from "@/components/notification-channels";
import { ColumnHeaders, RuledList } from "@/components/ruled-list";
import { Panel } from "@/components/ui/panel";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useNotificationChannels } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";

export default function NotificationsPage() {
  const t = useT();
  const channels = useNotificationChannels();
  // Fails closed to viewer while the role loads, like every other gated control. The server
  // enforces operator+ independently; this is UX, not the control.
  const canEdit = useCurrentRole() !== "viewer";

  const columns = [
    { key: "kind", label: t("notifications.col.kind") },
    { key: "where", label: t("notifications.col.where") },
    { key: "actions", label: canEdit ? t("notifications.col.actions") : "", className: "text-right" },
  ];

  return (
    <AppShell>
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold">{t("notifications.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">{t("notifications.subtitle")}</p>
      </div>

      {!canEdit ? (
        <Panel tone="lock" className="mt-4 p-3.5">
          <p className="text-[12.5px] text-muted-foreground text-pretty">{t("config.viewerLocked")}</p>
        </Panel>
      ) : null}

      <div className="mt-6">
        {channels.isPending ? <LoadingState /> : null}
        {channels.isError ? <ErrorState message={channels.error.message} onRetry={() => void channels.refetch()} /> : null}
        {channels.isSuccess && channels.data.length === 0 ? <EmptyState message={t("notifications.empty")} /> : null}
        {channels.isSuccess && channels.data.length > 0 ? (
          <RuledList>
            <ColumnHeaders columns={columns} gridClassName={CHANNEL_ROW_GRID} />
            {channels.data.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} canEdit={canEdit} />
            ))}
          </RuledList>
        ) : null}
      </div>

      {canEdit ? (
        <Panel tone="section" className="mt-6 p-5">
          <ChannelForm />
        </Panel>
      ) : null}
    </AppShell>
  );
}
