// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useEffect, useRef, useState } from "react";
import { LocaleFlag } from "@/components/locale-flag";
import { THEME_CHOICES, useThemeChoice, type ThemeChoice } from "@/components/theme-toggle";
import type { MessageKey } from "@/i18n/messages/en";
import { LOCALES, useI18n, type Locale } from "@/i18n/provider";
import { cn } from "@/lib/cn";

// One control in the bar for the three things that are about the person, not the fleet: the
// language, the theme, and leaving. The trigger shows the flag of the current language and
// nothing else, so the bar keeps its width for the nav; the panel lists every option with the
// current one marked, and closes on a choice, on Escape, or on a click outside.
const CODE: Record<Locale, string> = { en: "EN", "pt-BR": "PT-BR", es: "ES" };
const NATIVE: Record<Locale, MessageKey> = { en: "locale.native.en", "pt-BR": "locale.native.pt-BR", es: "locale.native.es" };
const THEME_LABEL: Record<ThemeChoice, MessageKey> = { system: "theme.system", light: "theme.light", dark: "theme.dark" };

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  if (choice === "light")
    return (
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  if (choice === "dark")
    return (
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className={cn("ml-auto shrink-0", on ? "text-accent" : "invisible")}>
      <path d="M2.5 6.5l2.5 2.5 4.5-5" />
    </svg>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <div className="px-3 pt-2.5 pb-1 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">{children}</div>;
}

const ROW = "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none";

export function AccountMenu({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const { locale, setLocale, t } = useI18n();
  const { choice, setChoice, system } = useThemeChoice();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={t("menu.label")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-control border px-2.5 transition-colors",
          open ? "border-border-region bg-muted" : "border-border hover:border-border-region hover:bg-muted",
        )}
      >
        <LocaleFlag locale={locale} />
        <span className="font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground">{CODE[locale]}</span>
        <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.4" className={cn("text-subtle-foreground transition-transform", open && "rotate-180")}>
          <path d="M1 3l3 3 3-3" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={t("menu.label")}
          className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-panel border border-border-region bg-card py-1 shadow-dialog"
        >
          <div className="truncate border-b border-border px-3 py-2 font-mono text-[11px] text-subtle-foreground">{email}</div>

          <SectionLabel>{t("locale.label")}</SectionLabel>
          {LOCALES.map((code) => (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={locale === code}
              className={ROW}
              onClick={() => {
                setLocale(code);
                setOpen(false);
              }}
            >
              <LocaleFlag locale={code} />
              <span>{t(NATIVE[code])}</span>
              <span className="font-mono text-[10.5px] tracking-[0.08em] text-subtle-foreground">{CODE[code]}</span>
              <Check on={locale === code} />
            </button>
          ))}

          <SectionLabel>{t("theme.label")}</SectionLabel>
          {THEME_CHOICES.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={choice === option}
              data-theme-choice={option}
              className={ROW}
              onClick={() => {
                setChoice(option);
                setOpen(false);
              }}
            >
              <span className="text-muted-foreground">
                <ThemeIcon choice={option} />
              </span>
              <span>{t(THEME_LABEL[option])}</span>
              {option === "system" ? (
                <span className="font-mono text-[10.5px] tracking-[0.06em] text-subtle-foreground">
                  {t("theme.systemNow", { mode: t(THEME_LABEL[system]).toLowerCase() })}
                </span>
              ) : null}
              <Check on={choice === option} />
            </button>
          ))}

          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              role="menuitem"
              className={ROW}
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-muted-foreground">
                <path d="M10 17l5-5-5-5M15 12H3M21 3v18" />
              </svg>
              <span>{t("nav.signOut")}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
