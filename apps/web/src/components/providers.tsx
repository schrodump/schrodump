// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { z } from "zod";
import { I18nProvider } from "@/i18n/provider";

// Zod compiles its validators with `new Function` when it can, and decides whether it can by
// calling `Function("")` inside a try/catch. Our CSP has no 'unsafe-eval' (next.config.ts), so that
// probe is refused, Zod falls back to the interpreted path — and the browser console carries a
// security-policy violation on every load of every page, for a call that was never going to
// succeed and whose failure changes nothing. Saying jitless up front skips the probe. It is set
// here because this provider is in every client bundle, before any form's schema is built.
z.config({ jitless: true });

export function Providers({ children }: { children: ReactNode }) {
  // Freshness is the product's whole subject, so the client defaults to telling the truth about it.
  // `refetchOnWindowFocus` was off: an operator who switched to a terminal, ran a restore and came
  // back read the screen they had left, with no hint it was a photograph. Per-query polling
  // (`use-live-refresh.ts`) does the rest, and never in the background — `refetchIntervalInBackground`
  // stays false so a hidden tab's timers fire against nobody.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: true, refetchIntervalInBackground: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <I18nProvider>{children}</I18nProvider>
    </QueryClientProvider>
  );
}
