// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Panel, type PanelTone } from "@/components/ui/panel";

// A Panel with role="alert". The three legacy variants map onto the design system's tones so the
// screens that still say <Alert variant="warning"> restyle without a rename; new code uses Panel.
type AlertVariant = "default" | "warning" | "destructive";
const TONE: Record<AlertVariant, PanelTone> = {
  default: "section",
  warning: "warning",
  destructive: "danger",
};

export type AlertProps = HTMLAttributes<HTMLDivElement> & { variant?: AlertVariant | null };

export function Alert({ className, variant, ...props }: AlertProps) {
  return (
    <Panel role="alert" tone={TONE[variant ?? "default"]} className={cn("w-full", className)} {...props} />
  );
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mb-1 font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
