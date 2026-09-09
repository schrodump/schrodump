// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

// Seven tones, one shape. Tone carries meaning and nothing else does: neutral for a section, an
// info note or a lock; amber for caution; red for a refusal or for what an irreversible action will
// do. A lock is deliberately NOT red — being unable to narrow a scope is a constraint, not an error,
// and a constraint painted like a failure teaches the operator to ignore red.
const panelVariants = cva("rounded-panel border p-4 text-sm", {
  variants: {
    tone: {
      section: "border-border bg-card shadow-card",
      info: "border-border-region bg-muted",
      lock: "border-border-region bg-muted",
      warning: "border-caution-border bg-caution-soft",
      danger: "border-destructive-border bg-destructive-soft",
      error: "border-destructive-border bg-destructive-soft",
      empty: "border-dashed border-border-region text-center text-muted-foreground",
    },
  },
  defaultVariants: { tone: "section" },
});

export type PanelTone = NonNullable<VariantProps<typeof panelVariants>["tone"]>;
export type PanelProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof panelVariants>;

export function Panel({ className, tone, ...props }: PanelProps) {
  return (
    <div
      data-tone={tone ?? "section"}
      className={cn(panelVariants({ tone }), className)}
      {...props}
    />
  );
}
