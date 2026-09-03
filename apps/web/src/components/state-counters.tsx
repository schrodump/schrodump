// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useT } from "@/i18n/provider";
import type { ArtifactState } from "@/lib/domain";

// One figure leads. Three equal tiles made "12 verified" the loudest thing on the screen, which
// inverts the product: there is no "OK" here, and the number that matters is the one nobody has
// answered yet. Unobserved is set at display size in amber; verified and failed are subordinate,
// and they stay subordinate at zero unobserved — a layout that changes shape when the fleet is
// clean is a layout the operator has to re-learn on the day it is not.
//
// No cards. The rule under the row does the separating, and the figure carries its own weight.
export function StateCounters({ counts }: { counts: Record<ArtifactState, number> }) {
  const t = useT();
  return (
    <div className="grid items-end gap-6 border-b border-border pb-6 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div
        data-testid="count-UNOBSERVED"
        data-lead="true"
        className="flex flex-col gap-0.5 text-[var(--color-state-unobserved)]"
      >
        <span className="text-6xl leading-[0.88] font-semibold tracking-[-0.05em] tabular-nums">
          {counts.UNOBSERVED}
        </span>
        <span className="text-base font-medium text-foreground">
          {t("dashboard.unobserved.caption")}
        </span>
        <span className="max-w-[42ch] text-sm text-[var(--color-foreground-soft)]">
          {t("dashboard.unobservedHint")}
        </span>
      </div>

      <div className="flex gap-9">
        <div data-testid="count-VERIFIED" data-lead="false" className="flex flex-col gap-0.5">
          <span className="text-3xl leading-tight font-semibold tracking-[-0.03em] tabular-nums text-[var(--color-state-verified)]">
            {counts.VERIFIED}
          </span>
          <span className="font-mono text-[0.68rem] tracking-[0.1em] text-muted-foreground uppercase">
            {t("dashboard.verified.label")}
          </span>
        </div>
        <div data-testid="count-FAILED" data-lead="false" className="flex flex-col gap-0.5">
          {/* Grey at zero, red only when there is something to be red about: a permanent red
              digit is a permanent alarm, and an alarm that is always on is furniture. */}
          <span
            className={
              counts.FAILED > 0
                ? "text-3xl leading-tight font-semibold tracking-[-0.03em] tabular-nums text-[var(--color-state-failed)]"
                : "text-3xl leading-tight font-semibold tracking-[-0.03em] tabular-nums text-muted-foreground"
            }
          >
            {counts.FAILED}
          </span>
          <span className="font-mono text-[0.68rem] tracking-[0.1em] text-muted-foreground uppercase">
            {t("dashboard.failed.label")}
          </span>
        </div>
      </div>
    </div>
  );
}
