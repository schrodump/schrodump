// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type MessageKey } from "./messages/en";
import { ptBR } from "./messages/pt-BR";
import { es } from "./messages/es";

export type Locale = "en" | "pt-BR" | "es";
export const LOCALES: Locale[] = ["en", "pt-BR", "es"];

const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, "pt-BR": ptBR, es };
const LOCALE_STORAGE_KEY = "schrodump.locale";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function I18nProvider({
  children,
  initialLocale = "en",
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored !== null && (LOCALES as string[]).includes(stored)) setLocaleState(stored as Locale);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => interpolate(dictionaries[locale][key], vars),
    [locale],
  );

  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error("useI18n must be used within an I18nProvider");
  return value;
}

export function useT(): Translate {
  return useI18n().t;
}
