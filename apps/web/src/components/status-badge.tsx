// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import type { ArtifactState } from "@/lib/domain";
import { cn } from "@/lib/cn";

// The ternary state, colored deliberately: VERIFIED green, UNOBSERVED amber (never gray, never
// green), FAILED red. There is no "OK".
const STYLES: Record<ArtifactState, { key: MessageKey; className: string }> = {
  VERIFIED: {
    key: "state.verified",
    className: "bg-[var(--color-state-verified-bg)] text-[var(--color-state-verified)]",
  },
  UNOBSERVED: {
    key: "state.unobserved",
    className: "bg-[var(--color-state-unobserved-bg)] text-[var(--color-state-unobserved)]",
  },
  FAILED: {
    key: "state.failed",
    className: "bg-[var(--color-state-failed-bg)] text-[var(--color-state-failed)]",
  },
};

export function StatusBadge({ state }: { state: ArtifactState }) {
  const t = useT();
  const style = STYLES[state];
  return (
    <span
      data-state={state}
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        style.className,
      )}
    >
      {t(style.key)}
    </span>
  );
}
