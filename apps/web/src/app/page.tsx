// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { AppShell } from "@/components/app-shell";
import { useT } from "@/i18n/provider";

export default function DashboardPage() {
  const t = useT();
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">{t("nav.dashboard")}</h1>
    </AppShell>
  );
}
