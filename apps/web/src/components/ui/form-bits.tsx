// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n/provider";

// The small parts every configuration form shares, so the three forms read as one family: the
// mode line above the title, the section and field labels in the mono uppercase voice, and the
// bar at the bottom whose primary action is never merely grey.

export function FormHeader({ mode, aside, title, intro }: { mode: string; aside?: string; title: string; intro?: string }) {
  return (
    <div className="max-w-2xl">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="rounded-sm border border-border-region bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-[0.13em] uppercase text-muted-foreground">
          {mode}
        </span>
        {aside !== undefined ? (
          <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-accent">{aside}</span>
        ) : null}
      </div>
      <h2 className="mt-2 text-xl font-semibold">{title}</h2>
      {intro !== undefined ? <p className="mt-1.5 text-sm text-muted-foreground text-pretty">{intro}</p> : null}
    </div>
  );
}

export function SectionLabel({ children, aside }: { children: string; aside?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">{children}</span>
      {aside !== undefined ? (
        <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-accent">{aside}</span>
      ) : null}
    </div>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return (
    <Label htmlFor={htmlFor} className="block font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
      {children}
    </Label>
  );
}

export function FieldHelp({ children, caution = false }: { children: ReactNode; caution?: boolean }) {
  return (
    <p className={caution ? "text-[12px] text-caution text-pretty" : "text-[12px] text-muted-foreground text-pretty"}>
      {children}
    </p>
  );
}

// `blocked` is the reason the primary action cannot run yet; null means it can. The note is what
// saving does, shown only while nothing is in the way — the reason takes its place otherwise.
export function SaveBar({
  note,
  blocked,
  pending,
  primary,
  onCancel,
}: {
  note: string;
  blocked: string | null;
  pending: boolean;
  primary: string;
  onCancel?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      {blocked === null ? (
        <span className="font-mono text-[10.5px] tracking-[0.04em] uppercase text-subtle-foreground">{note}</span>
      ) : (
        <span />
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
        {onCancel !== undefined ? (
          <Button type="button" variant="quiet" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
        <Button type="submit" variant="primary" disabled={pending} disabledReason={pending ? null : blocked}>
          {pending ? t("common.loading") : primary}
        </Button>
      </div>
    </div>
  );
}
