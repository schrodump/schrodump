// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { ReactNode } from "react";

// A second gate for the cases where the first is not enough: the sentence has to be read, and the
// caller keeps the primary action disabled until the box is ticked. The optional context line says
// why this particular case earned it.
export function AcknowledgeCheckbox({
  checked,
  onChange,
  children,
  context,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  context?: ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 rounded-control border border-border-region bg-muted px-3 py-3 text-sm">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block">{children}</span>
        {context !== undefined ? (
          <span className="mt-1 block text-[12.5px] text-muted-foreground">{context}</span>
        ) : null}
      </span>
    </label>
  );
}
