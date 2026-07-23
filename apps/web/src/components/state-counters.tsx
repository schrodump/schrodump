// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useT } from "@/i18n/provider";
import type { ArtifactState } from "@/lib/domain";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";

// The primary counter is "N unobserved backups" — never "N OK". An unverified backup is an open
// question, and the dashboard leads with it.
export function StateCounters({ counts }: { counts: Record<ArtifactState, number> }) {
  const t = useT();
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card className="border-[var(--color-state-unobserved)]/40 bg-[var(--color-state-unobserved-bg)]">
        <CardHeader>
          <CardTitle className="text-2xl text-[var(--color-state-unobserved)]">
            {t("dashboard.unobservedBackups", { count: counts.UNOBSERVED })}
          </CardTitle>
          <p className="text-xs text-[var(--color-state-unobserved)] opacity-90">
            {t("dashboard.unobservedHint")}
          </p>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-[var(--color-state-verified)]">
            {t("dashboard.verifiedBackups", { count: counts.VERIFIED })}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-[var(--color-state-failed)]">
            {t("dashboard.failedBackups", { count: counts.FAILED })}
          </CardTitle>
        </CardHeader>
      </Card>
    </div>
  );
}
