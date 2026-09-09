// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { BR, ES, US } from "country-flag-icons/react/3x2";
import type { Locale } from "@/i18n/provider";
import { cn } from "@/lib/cn";

// SVG flags, not emoji: an emoji flag renders as two letters on Windows and as a different drawing
// on every platform, and a language picker that looks broken on one operating system is worse
// than a plain code. The flag stands for the locale, not the country — Brazilian Portuguese is
// the variant this app ships, so its flag is the honest one.
const FLAGS: Record<Locale, typeof US> = { en: US, "pt-BR": BR, es: ES };

export function LocaleFlag({ locale, className }: { locale: Locale; className?: string }) {
  const Flag = FLAGS[locale];
  return (
    <span aria-hidden="true" className={cn("inline-block h-3.5 w-5 shrink-0 overflow-hidden rounded-[2px] ring-1 ring-border", className)}>
      <Flag className="block h-full w-full" />
    </span>
  );
}
