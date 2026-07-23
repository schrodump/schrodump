// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const alertVariants = cva("relative w-full rounded-lg border p-4 text-sm", {
  variants: {
    variant: {
      default: "bg-card text-card-foreground",
      warning: "border-[var(--color-state-unobserved)]/40 bg-[var(--color-state-unobserved-bg)] text-[var(--color-state-unobserved)]",
      destructive: "border-destructive/40 bg-[var(--color-state-failed-bg)] text-[var(--color-state-failed)]",
    },
  },
  defaultVariants: { variant: "default" },
});

export type AlertProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>;

export function Alert({ className, variant, ...props }: AlertProps) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mb-1 font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm opacity-90", className)} {...props} />;
}
