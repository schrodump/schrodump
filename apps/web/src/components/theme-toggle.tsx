// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useEffect, useState } from "react";

// Three states, not two: the default follows the browser's colour scheme, and an explicit choice
// stamps `data-theme` on <html>, which is what the `light-dark()` tokens in globals.css read.
// The choice lives in localStorage under one key, and the layout applies it before hydration so
// the first paint is already the right one.
export const THEME_STORAGE_KEY = "schrodump-theme";
export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const THEME_CHOICES: ThemeChoice[] = ["system", "light", "dark"];

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

const DARK_QUERY = "(prefers-color-scheme: dark)";

// What the browser reports for "system" — surfaced beside the option, because an operating system
// in dark mode and a browser set to light look, from the page, like a toggle that does not work.
function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function useThemeChoice(): {
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
  system: ResolvedTheme;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>("system");
  const [system, setSystem] = useState<ResolvedTheme>("light");

  useEffect(() => {
    setChoiceState(readStoredTheme());
    setSystem(readSystemTheme());
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystem(readSystemTheme());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  function setChoice(next: ThemeChoice) {
    applyTheme(next);
    setChoiceState(next);
  }

  return { choice, setChoice, system };
}
