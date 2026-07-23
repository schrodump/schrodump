// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";

// Every panel here needs a server endpoint that does not exist yet (keys, members, instance
// config). The page states that plainly instead of inventing data.
const PANELS: { title: MessageKey; description: MessageKey }[] = [
  { title: "settings.keys", description: "settings.keys.description" },
  { title: "settings.members", description: "settings.members.description" },
  { title: "settings.instance", description: "settings.instance.description" },
];

export default function SettingsPage() {
  const t = useT();
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {PANELS.map((panel) => (
          <Card key={panel.title}>
            <CardHeader>
              <CardTitle>{t(panel.title)}</CardTitle>
              <CardDescription>{t(panel.description)}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{t("common.endpointPending")}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </AppShell>
  );
}
