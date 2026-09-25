// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";

// A screen that refreshes itself and a screen that is frozen look identical until something
// changes, and this product's whole subject is whether what you are reading is still true. So the
// page says which it is — and says the cadence it is ACTUALLY running at, handed in from the same
// policy the queries use, rather than a number retyped here that could drift from them.
//
// `false` is the hidden-tab case: not "broken", not "every 0 seconds" — deliberately not polling,
// because nobody is reading it. It is said out loud so a returning operator does not read the first
// stale second as the product being wrong.
export function LiveIndicator({ intervalMs, className }: { intervalMs: number | false; className?: string }) {
  const t = useT();
  return (
    <p
      data-testid="live-indicator"
      data-live={intervalMs === false ? "paused" : String(intervalMs)}
      className={cn("font-mono text-[10.5px] tracking-[0.04em] text-subtle-foreground", className)}
    >
      {intervalMs === false
        ? t("live.paused")
        : t("live.refreshing", { seconds: String(Math.round(intervalMs / 1000)) })}
    </p>
  );
}
