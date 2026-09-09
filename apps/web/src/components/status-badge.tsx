// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import type { ArtifactState } from "@/lib/domain";
import { cn } from "@/lib/cn";

// The ternary state, and the most designed object in this interface: it is what an operator reads
// first, from across a room, mid-incident. There is no fourth state and no checkmark.
//
// Each state carries a SHAPE as well as a colour. Colour alone fails anyone who cannot separate
// the hues and fails everyone in greyscale, and this is the one badge in the product where being
// misread has a cost — mistaking UNOBSERVED for VERIFIED is mistaking a question for an answer.
// VERIFIED is a sealed ring (proven by observation — deliberately not a checkmark), UNOBSERVED a
// rotated square (the open question is the one shape not at rest), FAILED a triangle. The marker
// is a real element carrying data-marker, so the property can be asserted instead of merely
// intended.
type Marker = "disc" | "diamond" | "triangle";

const STYLES: Record<ArtifactState, { key: MessageKey; marker: Marker; className: string }> = {
  VERIFIED: {
    key: "state.verified",
    marker: "disc",
    className: "border-state-verified-border bg-state-verified-soft text-state-verified",
  },
  UNOBSERVED: {
    key: "state.unobserved",
    marker: "diamond",
    className: "border-state-unobserved-border bg-state-unobserved-soft text-state-unobserved",
  },
  FAILED: {
    key: "state.failed",
    marker: "triangle",
    className: "border-state-failed-border bg-state-failed-soft text-state-failed",
  },
};

function Glyph({ marker }: { marker: Marker }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={11}
      height={11}
      aria-hidden="true"
      data-marker={marker}
      className="shrink-0"
    >
      {marker === "disc" ? (
        <>
          <circle cx="6" cy="6" r="5.2" fill="currentColor" />
          <circle cx="6" cy="6" r="2" className="fill-card" />
        </>
      ) : marker === "diamond" ? (
        <path d="M6 .6 11.4 6 6 11.4.6 6Z" fill="currentColor" />
      ) : (
        <path d="M6 .5 11.6 10.4H.4Z" fill="currentColor" />
      )}
    </svg>
  );
}

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
        "inline-flex items-center gap-[7px] rounded-chip border px-2 py-[2px]",
        "font-mono text-[11px] font-medium tracking-[0.06em] uppercase",
        style.className,
      )}
    >
      <Glyph marker={style.marker} />
      {t(style.key)}
    </span>
  );
}

// The design system's name for it. StatusBadge stays for the call sites and tests already written.
export { StatusBadge as StateMarker };
