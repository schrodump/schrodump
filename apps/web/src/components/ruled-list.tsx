// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { ReactNode } from "react";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";

// The product is a ledger: one ruled list, several screens. Column headers in the tracked label; a
// day-group header on the elevated surface; and a footer that says how much of the truth is on
// screen — a truncated list says so, and the counters above it come from the server.
// The list is a card: one region on the ground with a rule around it, a raise, and the rows,
// headers and footer inside sharing an 18px gutter. Rows are separated by the row rule, never
// boxed — forty equally-boxed objects ask the eye to separate what the content already separates.
export function RuledList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-panel border border-border bg-card shadow-card", className)}>{children}</div>;
}

export function ColumnHeaders({
  columns,
  gridClassName,
}: {
  columns: { key: string; label: string; className?: string }[];
  gridClassName: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid items-center gap-x-4 border-b border-border px-[18px] py-2.5 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground",
        gridClassName,
      )}
    >
      {columns.map((column) => (
        <span key={column.key} className={column.className}>
          {column.label}
        </span>
      ))}
    </div>
  );
}

export function GroupHeader({ label, count }: { label: string; count: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-border bg-muted px-[18px] py-2 font-mono text-[10.5px] tracking-[0.13em] uppercase">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-subtle-foreground">{count}</span>
    </div>
  );
}

// `total > shown` is the only time the truncation sentence appears; the note about the counters
// is always there, because the number that matters is the one the list cannot show.
export function ListFooter({ shown, total, note }: { shown: number; total: number; note?: string }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-[18px] py-2.5 font-mono text-[10.5px] tracking-[0.04em] text-subtle-foreground">
      <span>
        {total > shown ? t("list.truncated", { shown: String(shown), total: String(total) }) : null}
        {total > shown && note !== undefined ? " · " : ""}
        {note}
      </span>
    </div>
  );
}
