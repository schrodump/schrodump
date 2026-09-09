// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { StateGlyph } from "@/components/status-badge";
import type { ArtifactState } from "@/lib/domain";
import { cn } from "@/lib/cn";

// Always carries its count, so the filter row doubles as a census of the whole table — and the
// count is the server's, never the page's. A state filter also carries the state's marker; a plain
// filter does not.
export function FilterChip({
  label,
  count,
  active = false,
  state,
  onClick,
}: {
  label: string;
  count: number | string;
  active?: boolean;
  state?: ArtifactState;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-2 rounded-control border px-3 py-1.5 font-mono text-[11.5px] transition-colors",
        active
          ? "border-border-region bg-muted text-foreground"
          : "border-border text-muted-foreground hover:border-border-region hover:text-foreground",
      )}
    >
      {state !== undefined ? (
        <span className={`text-state-${state.toLowerCase()}`}>
          <StateGlyph state={state} size={8} />
        </span>
      ) : null}
      <span>{label}</span>
      <span className="tabular-nums opacity-65">{count}</span>
    </button>
  );
}
