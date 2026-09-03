// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import type { ArtifactState } from "@/lib/domain";
import { cn } from "@/lib/cn";

// The ternary state, and the most designed object in this interface: it is what an operator reads
// first, from across a room, mid-incident.
//
// Each state carries a SHAPE as well as a colour. Colour alone fails anyone who cannot separate
// the hues and fails everyone in greyscale, and this is the one badge in the product where being
// misread has a cost — mistaking UNOBSERVED for VERIFIED is mistaking a question for an answer.
// The marker is a real element rather than a ::before so the property can be asserted in a test
// instead of merely intended.
const STYLES: Record<
  ArtifactState,
  { key: MessageKey; marker: "disc" | "diamond" | "triangle"; className: string; markerClass: string }
> = {
  VERIFIED: {
    key: "state.verified",
    marker: "disc",
    className: "bg-[var(--color-state-verified-bg)] text-[var(--color-state-verified)]",
    markerClass: "rounded-full bg-[var(--color-state-verified)]",
  },
  UNOBSERVED: {
    key: "state.unobserved",
    marker: "diamond",
    className: "bg-[var(--color-state-unobserved-bg)] text-[var(--color-state-unobserved)]",
    // Rotated square: the open question is the one shape that is not at rest.
    markerClass: "rotate-45 bg-[var(--color-state-unobserved)]",
  },
  FAILED: {
    key: "state.failed",
    marker: "triangle",
    className: "bg-[var(--color-state-failed-bg)] text-[var(--color-state-failed)]",
    markerClass: "bg-[var(--color-state-failed)] [clip-path:polygon(50%_0,100%_100%,0_100%)]",
  },
};

export function StatusBadge({ state }: { state: ArtifactState }) {
  const t = useT();
  const style = STYLES[state];
  return (
    <span
      data-state={state}
      data-testid={`state-${state}`}
      className={cn(
        // Monospace, uppercase and tracked: this is a machine's word for a machine's fact, and it
        // sits in columns beside other identifiers. A rounded pill in body type reads as a tag,
        // which is the wrong register for the central claim of the product.
        "inline-flex items-center gap-1.5 rounded-[3px] px-1.5 py-0.5",
        "font-mono text-[0.66rem] font-semibold tracking-[0.07em] uppercase",
        style.className,
      )}
    >
      <span
        aria-hidden="true"
        data-marker={style.marker}
        className={cn("size-1.5 shrink-0", style.markerClass)}
      />
      {t(style.key)}
    </span>
  );
}
