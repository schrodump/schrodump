// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { cn } from "@/lib/cn";

// A number with its name, its unit line, and one sentence on what it means. The tone is the
// meaning, not decoration: `caution` for a number that asks for attention (a queue that has waited
// past five minutes), `danger` for a broken process (failed runs today), `quiet` for a count that is
// neither — a verify that could not run is not a failure, and must not be painted like one.
const TONE = {
  plain: { box: "border-border bg-card", label: "text-subtle-foreground", value: "text-foreground", sub: "text-subtle-foreground" },
  quiet: { box: "border-border-region bg-card", label: "text-muted-foreground", value: "text-foreground", sub: "text-subtle-foreground" },
  caution: { box: "border-caution-border bg-caution-soft", label: "text-caution", value: "text-caution", sub: "text-caution" },
  danger: {
    box: "border-destructive-border bg-destructive-soft",
    label: "text-destructive-text",
    value: "text-destructive-text",
    sub: "text-muted-foreground",
  },
} as const;

export type MetricTone = keyof typeof TONE;

export function MetricTile({
  label,
  value,
  sub,
  note,
  tone = "plain",
}: {
  label: string;
  value: string;
  sub?: string;
  note?: string;
  tone?: MetricTone;
}) {
  const ink = TONE[tone];
  return (
    <div data-tone={tone} className={cn("rounded-panel border px-4 py-[15px]", ink.box)}>
      <div className={cn("font-mono text-[10px] tracking-[0.13em] uppercase", ink.label)}>{label}</div>
      <div className="mt-2 flex items-baseline gap-2.5">
        <span className={cn("font-mono text-[30px] leading-none font-medium tracking-[-0.03em] tabular-nums", ink.value)}>
          {value}
        </span>
        {sub !== undefined && sub !== "" ? (
          <span className={cn("min-w-0 font-mono text-[11px]", ink.sub)}>{sub}</span>
        ) : null}
      </div>
      {note !== undefined ? <p className="mt-2.5 text-[12px] text-muted-foreground text-pretty">{note}</p> : null}
    </div>
  );
}
