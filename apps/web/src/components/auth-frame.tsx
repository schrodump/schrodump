// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Panel } from "@/components/ui/panel";
import { useT } from "@/i18n/provider";

// The frame the three out-of-app screens share — sign-in, first-run setup, the bootstrap-password
// wall: the mark and the name, a title, one sentence, then the form. Nothing else is on screen,
// because the server refuses everything else in these states and a control that would only
// produce an error is worse than none.
export function AuthFrame({
  title,
  intro,
  footer,
  children,
  width = "max-w-sm",
}: {
  title: string;
  intro?: ReactNode;
  footer?: string;
  children: ReactNode;
  width?: string;
}) {
  const t = useT();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Panel tone="section" className={`w-full ${width} p-6 shadow-dialog`}>
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-7" />
          <span className="text-[15px] font-semibold tracking-tight">{t("app.name")}</span>
        </div>
        <h1 className="mt-5 text-xl font-semibold">{title}</h1>
        {intro !== undefined ? <div className="mt-1.5 text-sm text-muted-foreground text-pretty">{intro}</div> : null}
        <div className="mt-5">{children}</div>
        {footer !== undefined ? (
          <p className="mt-5 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">{footer}</p>
        ) : null}
      </Panel>
    </div>
  );
}
