// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { EncryptionKeysPanel } from "@/components/encryption-keys";
import { InstancePanel } from "@/components/instance-panel";
import { MembersPanel } from "@/components/members-panel";
import { SelfBackupPanel } from "@/components/self-backup-panel";
import { useCurrentRole } from "@/hooks/use-current-role";
import { useT } from "@/i18n/provider";

export default function SettingsPage() {
  const t = useT();
  const role = useCurrentRole();
  return (
    <AppShell>
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">{t("settings.intro")}</p>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <EncryptionKeysPanel canEdit={role === "admin"} />
        <SelfBackupPanel />
        <InstancePanel />
        <MembersPanel />
      </div>
    </AppShell>
  );
}
