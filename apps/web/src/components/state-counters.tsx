// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { ReactNode } from "react";
import { StateGlyph } from "@/components/status-badge";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import type { ArtifactState } from "@/lib/domain";

// One figure leads. Three equal tiles made "12 verified" the loudest thing on the screen, which
// inverts the product: there is no "OK" here, and the number that matters is the one nobody has
// answered yet. Unobserved is set at display size in amber, with its diamond; verified and failed
// are subordinate, and they stay subordinate at zero unobserved — a layout that changes shape when
// the fleet is clean is a layout the operator has to re-learn on the day it is not. FAILED is grey
// until there is something to be red about: a permanent red digit is a permanent alarm, and an
// alarm that is always on is furniture.
export function StateCounters({
  counts,
  total,
  verifiedByLevel,
  caption,
  hint,
  facts,
}: {
  counts: Record<ArtifactState, number>;
  total?: number;
  // Splits the green: a restore that reproduced the database is not the same claim as a hash
  // that matched, and the header says how many of each.
  verifiedByLevel?: { FULL_RESTORE: number; CHECKSUM: number };
  caption?: string;
  hint?: string;
  // A line of named facts under the figures — the oldest open question, for one.
  facts?: ReactNode;
}) {
  const t = useT();
  const nothingWritten = total === 0;
  const failedZero = counts.FAILED === 0;
  return (
    <div>
      <div className="grid items-end gap-6 border-b border-border pb-6 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div data-testid="count-UNOBSERVED" data-lead="true" className="flex flex-col gap-1 text-state-unobserved">
          <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.13em] uppercase">
            <StateGlyph state="UNOBSERVED" size={10} />
            {t("state.unobserved")}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-mono text-[76px] leading-[0.9] font-medium tracking-[-0.05em] tabular-nums">
              {counts.UNOBSERVED.toLocaleString()}
            </span>
            <span className="text-base font-medium text-foreground">{caption ?? t("dashboard.unobserved.caption")}</span>
          </div>
          <span className="max-w-[46ch] text-sm text-muted-foreground text-pretty">
            {nothingWritten ? t("dashboard.firstRunHint") : (hint ?? t("dashboard.unobservedHint"))}
          </span>
        </div>

        <div className="flex gap-10">
          <div data-testid="count-VERIFIED" data-lead="false" className="flex flex-col gap-1">
            <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.13em] uppercase text-state-verified">
              <StateGlyph state="VERIFIED" size={10} />
              {t("state.verified")}
            </div>
            <span className="font-mono text-3xl leading-tight font-medium tracking-[-0.03em] tabular-nums text-state-verified">
              {counts.VERIFIED.toLocaleString()}
            </span>
            <span className="font-mono text-[10.5px] tracking-[0.06em] text-subtle-foreground">
              {verifiedByLevel !== undefined
                ? t("counters.verifiedBy", {
                    full: verifiedByLevel.FULL_RESTORE.toLocaleString(),
                    checksum: verifiedByLevel.CHECKSUM.toLocaleString(),
                  })
                : t("dashboard.verified.label")}
            </span>
          </div>
          <div data-testid="count-FAILED" data-lead="false" className="flex flex-col gap-1">
            <div
              className={cn(
                "flex items-center gap-2 font-mono text-[10.5px] tracking-[0.13em] uppercase",
                failedZero ? "text-subtle-foreground" : "text-state-failed",
              )}
            >
              {failedZero ? (
                <span aria-hidden="true" className="inline-block size-2.5 rounded-[1px] bg-current opacity-50" />
              ) : (
                <StateGlyph state="FAILED" size={10} />
              )}
              {t("state.failed")}
            </div>
            <span
              className={cn(
                "font-mono text-3xl leading-tight font-medium tracking-[-0.03em] tabular-nums",
                failedZero ? "text-subtle-foreground" : "text-state-failed",
              )}
            >
              {counts.FAILED.toLocaleString()}
            </span>
            <span className={cn("font-mono text-[10.5px] tracking-[0.06em]", failedZero ? "text-subtle-foreground" : "text-state-failed")}>
              {failedZero ? t("dashboard.failed.zeroNote") : t("dashboard.failed.note")}
            </span>
          </div>
        </div>
      </div>
      {facts !== undefined ? <div className="mt-3">{facts}</div> : null}
      <p className="mt-2 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">{t("dashboard.countedNote")}</p>
    </div>
  );
}
