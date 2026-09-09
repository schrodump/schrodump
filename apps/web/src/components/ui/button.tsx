// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, useId, type ButtonHTMLAttributes } from "react";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";

// Six variants, one shape. The amber fill is reserved for the one primary action on a screen;
// `accent` (outlined amber) is Verify — an invitation to answer a question, not a commitment;
// `danger` is the irreversible ones.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control text-[13px] font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-accent-soft disabled:pointer-events-none",
  {
    variants: {
      variant: {
        primary:
          "border border-primary bg-primary font-semibold text-primary-foreground hover:bg-primary-hover",
        secondary: "border border-border-region bg-muted text-foreground",
        quiet:
          "border border-border text-muted-foreground hover:border-border-region hover:text-foreground",
        ghost: "text-subtle-foreground hover:bg-muted hover:text-foreground",
        accent: "border border-accent-border bg-accent-soft text-accent",
        danger:
          "border border-destructive-border bg-destructive font-semibold text-destructive-foreground hover:bg-destructive-hover",
      },
      size: {
        default: "px-4 py-2",
        sm: "px-3 py-1.5 text-xs",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export { buttonVariants };

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    // The design system's only way to disable a button: the reason is rendered beside it, in the
    // caution tone, as "Blocked — <reason>". There are no bare greyed-out controls in this product —
    // a control that refuses without saying why trades an explanation for a mystery. Plain
    // `disabled` still works for the screens that predate this; they lose the sentence, not the lock.
    disabledReason?: string | null;
  };

function BlockedReason({ id, reason }: { id: string; reason: string }) {
  const t = useT();
  return (
    <span
      id={id}
      data-testid="button-blocked-reason"
      className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-caution"
    >
      {t("common.blocked")} — {reason}
    </span>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", disabledReason, disabled, ...props }, ref) => {
    const id = useId();
    const blocked = disabledReason !== undefined && disabledReason !== null && disabledReason !== "";
    const off = blocked || disabled === true;
    const button = (
      <button
        ref={ref}
        type={type}
        disabled={off}
        aria-describedby={blocked ? id : undefined}
        className={cn(
          buttonVariants({ variant, size }),
          off && "cursor-not-allowed border-border bg-transparent text-subtle-foreground opacity-60",
          className,
        )}
        {...props}
      />
    );
    // A button that takes part in the reason protocol keeps the wrapper even while the reason is
    // null: if the wrapper appeared only when a reason did, React would swap a bare <button> for a
    // <span><button/></span> and REMOUNT the button — a handle captured before the reason appeared
    // (a test's, a focus ring's) would then point at a detached node.
    if (disabledReason === undefined) return button;
    return (
      // The reason reads before the button: in a right-aligned footer it sits to the left of the
      // action it explains, and if the pair wraps the button ends the line.
      <span className="inline-flex flex-wrap items-center justify-end gap-3">
        {blocked ? <BlockedReason id={id} reason={disabledReason} /> : null}
        {button}
      </span>
    );
  },
);
Button.displayName = "Button";
