// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import localFont from "next/font/local";

// Vendored, not fetched: `next/font/google` downloads at build time, and a `docker build` on a host
// without internet would fail on a typeface. Both are SIL OFL 1.1 (licences alongside), variable
// fonts, so one file per face covers every weight the design uses. Instrument Sans for anything a
// person wrote; JetBrains Mono for anything a machine produced — ids, sizes, checksums, states.
export const sans = localFont({
  src: [
    { path: "./instrument-sans.woff2", style: "normal", weight: "400 700" },
    { path: "./instrument-sans-italic.woff2", style: "italic", weight: "400 700" },
  ],
  variable: "--font-instrument-sans",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

export const mono = localFont({
  src: [{ path: "./jetbrains-mono.woff2", style: "normal", weight: "100 800" }],
  variable: "--font-jetbrains-mono",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});
