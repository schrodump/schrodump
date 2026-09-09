// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Label in the tracked style, value in mono. A fact with no value is OMITTED — the grid reflows
// rather than showing an empty slot or an em dash. A null is an absence; painting a placeholder
// where a value should be is how someone at 3am reads "—" as data.
export type Fact = {
  label: string;
  value: ReactNode | null | undefined;
  tone?: "plain" | "caution" | "danger" | "verified";
};

const TONE: Record<NonNullable<Fact["tone"]>, string> = {
  plain: "text-foreground",
  caution: "text-caution",
  danger: "text-destructive-text",
  verified: "text-state-verified",
};

const present = (fact: Fact): boolean =>
  fact.value !== null && fact.value !== undefined && fact.value !== "";

export function DetailGrid({ facts, className }: { facts: Fact[]; className?: string }) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-3.5 [grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))]",
        className,
      )}
    >
      {facts.filter(present).map((fact) => (
        <div key={fact.label} className="min-w-0">
          <dt className="font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
            {fact.label}
          </dt>
          <dd className={cn("mt-1 break-words font-mono text-[12px]", TONE[fact.tone ?? "plain"])}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
