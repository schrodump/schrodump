// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The web talks to the server through same-origin rewrites so the Better-Auth session cookie is
// same-origin (no CORS, no server change). SCHRODUMP_API_URL points at apps/server.
//
// Rewrites are baked into the routes manifest at build time, so this value is fixed when the
// production image is built — not when the container starts.
const server = process.env.SCHRODUMP_API_URL ?? "http://localhost:8080";

// The strictest policy this application actually runs under. Measured in a browser against a
// production build, not reasoned about — every relaxation below is a thing that broke.
//
// `frame-ancestors 'none'` is the point of the exercise. The two most destructive controls in the
// product are one click each: the restore dialog writes over a live database, and the delete
// dialog destroys a VERIFIED artifact. With no framing control an operator who is already signed
// in can be made to click either one through an invisible iframe on a page they were led to.
//
// `script-src` keeps `'unsafe-inline'`, and that is a limit of the framework rather than a choice.
// Next serves the RSC payload as a chain of inline `self.__next_f.push([...])` scripts whose
// content differs per page and per build, so no hash can cover them; a nonce has to come from
// middleware, and reading it in the layout makes every route render dynamically (all thirteen are
// prerendered today). Worse, listing the theme script's own hash here would make browsers ignore
// `'unsafe-inline'` — CSP2 drops it as soon as a hash or a nonce is present — and take Next's
// bootstrap down with it, leaving a page that never hydrates. So the inline theme script in
// `src/app/layout.tsx` is covered by the same relaxation, and the XSS half of CSP is weaker than
// the rest. `docs/security.md` records it as a known limit.
//
// `style-src` keeps it too: React writes inline `style` attributes (the brand mark's two fills, the
// setup progress bar, the proportion bars) and never nonces them.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Everything the UI draws is same-origin: the favicon, and fonts vendored into the bundle. The
  // flags in the locale picker are React components, not images.
  "img-src 'self' data:",
  "font-src 'self'",
  // The API is reached through the rewrites below, so it is this same origin.
  "connect-src 'self'",
].join("; ");

// No `Strict-Transport-Security`. The deployment serves plain HTTP and TLS is terminated by the
// operator's own reverse proxy (docs/install.md), which is where HSTS belongs: sent from here it
// would either be stripped by that proxy or, worse, pin a hostname reached over HTTP into every
// browser that ever loaded it.
export const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  // `frame-ancestors` already says this; X-Frame-Options says it to what predates CSP2.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // An artifact id or a target name in a Referer is a leak to wherever the operator clicks next.
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig: NextConfig = {
  // The production image ships only traced files; without this the runtime would need the whole
  // node_modules of the app. Tracing is rooted at the monorepo, not at apps/web.
  // `next dev` would otherwise append a generated "agent rules" block to apps/web/CLAUDE.md on
  // every start, leaving the tree dirty; that file is hand-written and reviewed.
  agentRules: false,
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  async headers() {
    // Every route this app serves itself. The two rewritten prefixes are excluded because the
    // API answers them with its own headers (@fastify/helmet, apps/server/src/app.ts) and a
    // rewrite forwards those: a second X-Frame-Options would make the pair a duplicate, which a
    // browser discards instead of enforcing.
    return [{ source: "/((?!api/auth/|backend/).*)", headers: securityHeaders }];
  },
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${server}/api/auth/:path*` },
      { source: "/backend/:path*", destination: `${server}/:path*` },
    ];
  },
};

export default nextConfig;
