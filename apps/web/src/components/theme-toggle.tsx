// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useEffect, useState } from "react";
import { useT } from "@/i18n/provider";

// Three states, not two: the default follows the system, and an explicit choice stamps
// `data-theme` on <html>, which is what the `light-dark()` tokens in globals.css read. The choice
// lives in localStorage under one key, and the layout applies it before hydration so the first
// paint is already the right one.
export const THEME_STORAGE_KEY = "schrodump-theme";
export type ThemeChoice = "system" | "light" | "dark";
const ORDER: ThemeChoice[] = ["system", "light", "dark"];

export function readStoredTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage unavailable: the choice still applies to this page.
  }
}

function Icon({ choice }: { choice: ThemeChoice }) {
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

export function ThemeToggle() {
  const t = useT();
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => setChoice(readStoredTheme()), []);

  function next() {
    const following = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? "system";
    applyTheme(following);
    setChoice(following);
  }

  const label = t(`theme.${choice}`);
  return (
    <button
      type="button"
      onClick={next}
      title={`${t("theme.label")}: ${label}`}
      aria-label={`${t("theme.label")}: ${label}`}
      data-theme-choice={choice}
      className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border px-2.5 font-mono text-[10.5px] tracking-[0.08em] uppercase text-muted-foreground transition-colors hover:border-border-region hover:text-foreground"
    >
      <Icon choice={choice} />
      {label}
    </button>
  );
}
