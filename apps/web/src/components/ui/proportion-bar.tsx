// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { cn } from "@/lib/cn";

// The fleet's shape in one line: how much of it is still a question. Parts are ordered as given
// (amber, then green, then red) and sized by share; an empty fleet paints nothing rather than a
// full bar of one colour that would claim something.
export function ProportionBar({
  parts,
  label,
  className,
}: {
  parts: { key: string; value: number; className: string }[];
  label: string;
  className?: string;
}) {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("flex h-1 overflow-hidden rounded-sm bg-muted", className)}
    >
      {total > 0
        ? parts.map((part) => (
            <div
              key={part.key}
              data-part={part.key}
              className={part.className}
              style={{ width: `${(Math.max(0, part.value) / total) * 100}%` }}
            />
          ))
        : null}
    </div>
  );
}
