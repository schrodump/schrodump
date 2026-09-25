// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useMemo } from "react";
import { useI18n } from "../i18n/provider";
import { formatDate, formatDateTime, formatRelative, formatTime } from "./format";

// The four date formatters, bound to the locale the language menu actually selected.
//
// They exist because `Intl` defaults to the BROWSER's locale, which is a different setting from the
// app's: switching the interface to Portuguese translated every label and left every date and every
// "2 days ago" in whatever the browser was set to. The formatters in `format.ts` now REQUIRE a
// locale, and this is the one place a component gets it — the same shape as `useT()`, next to it in
// every component that renders a timestamp.
export interface Format {
  dateTime(iso: string): string;
  time(iso: string): string;
  date(iso: string): string;
  // `now` is injectable for the same reason the underlying function takes it: the jobs ledger ticks
  // its own clock, so every row on one render has to be measured against the same instant.
  relative(iso: string, now?: Date): string;
}

export function useFormat(): Format {
  const { locale } = useI18n();
  return useMemo<Format>(
    () => ({
      dateTime: (iso) => formatDateTime(locale, iso),
      time: (iso) => formatTime(locale, iso),
      date: (iso) => formatDate(locale, iso),
      relative: (iso, now) => formatRelative(locale, iso, now),
    }),
    [locale],
  );
}
