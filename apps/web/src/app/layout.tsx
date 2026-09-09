// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { mono, sans } from "@/fonts";
import { en } from "@/i18n/messages/en";
import "./globals.css";

export const metadata: Metadata = {
  title: en["app.name"],
  description: en["app.tagline"],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The font variables live on <html> so every portal — dialogs render into document.body —
    // inherits them; `font-sans` on body is the default face, `font-mono` opts a machine fact in.
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
