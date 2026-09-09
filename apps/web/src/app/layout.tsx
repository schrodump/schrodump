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
        {/* The stored theme, stamped before the first paint: a page that hydrates light and then
            turns dark is a flash the operator sees on every navigation. One key, read once. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('schrodump-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t}}catch(e){}",
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
