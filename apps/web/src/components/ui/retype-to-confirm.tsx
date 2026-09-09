// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";

// The gate on anything irreversible. The subject is stated, the match is exact, the error is inline,
// and it is the caller that keeps the primary action disabled until `value === subject`. A mismatch
// is only reported once something has been typed — an empty field is not yet a wrong answer.
export function RetypeToConfirm({
  id,
  label,
  hint,
  subject,
  value,
  onChange,
  mismatch,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  subject: string;
  value: string;
  onChange: (value: string) => void;
  mismatch: string;
}) {
  const touched = value.length > 0;
  const ok = value === subject;
  return (
    <Panel tone="danger" className="p-3.5">
      <label
        htmlFor={id}
        className="block font-mono text-[10px] tracking-[0.13em] uppercase text-destructive-text"
      >
        {label}
      </label>
      {hint !== undefined ? <p className="mt-1 mb-2 text-[12.5px] text-muted-foreground">{hint}</p> : null}
      <Input
        id={id}
        value={value}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={touched && !ok ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn("font-mono", touched && !ok && "border-destructive-border")}
      />
      {touched && !ok ? (
        <p role="alert" className="mt-2 font-mono text-[11.5px] text-destructive-text">
          {mismatch}
        </p>
      ) : null}
    </Panel>
  );
}
