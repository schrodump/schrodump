// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { en } from "@/i18n/messages/en";
import "./globals.css";

export const metadata: Metadata = {
  title: en["app.name"],
  description: en["app.tagline"],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
