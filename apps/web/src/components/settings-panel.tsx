// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { ReactNode } from "react";
import { Panel } from "@/components/ui/panel";
import { useT } from "@/i18n/provider";

// One shape for the four settings panels: a mono title, one sentence, an optional aside, the body.
// The admin-only refusal is a sentence in the lock tone, never an empty list that reads as
// "nothing here".
export function SettingsPanel({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <Panel tone="section" className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-md">
          <h2 className="font-mono text-[11px] tracking-[0.13em] uppercase text-foreground">{title}</h2>
          {description !== undefined ? (
            <p className="mt-1 text-[12.5px] text-muted-foreground text-pretty">{description}</p>
          ) : null}
        </div>
        {aside !== undefined ? (
          <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-accent">{aside}</span>
        ) : null}
      </div>
      <div className="mt-4">{children}</div>
    </Panel>
  );
}

export function AdminOnly({ children }: { children: string }) {
  return (
    <Panel tone="lock" className="p-3">
      <p className="text-[12.5px] text-muted-foreground">{children}</p>
    </Panel>
  );
}

export function LoadingLine() {
  const t = useT();
  return <p className="font-mono text-[11px] text-subtle-foreground">{t("common.loading")}</p>;
}
