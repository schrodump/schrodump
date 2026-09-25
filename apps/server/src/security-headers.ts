// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";

// The API answers JSON and nothing else — no page, no script, no stylesheet, no frame. So its
// policy is the one a document can never have: deny everything, and say so on every response
// including the 401s and the 404s, which is why this is a global plugin and not a route option.
//
// The UI sets its own, richer policy in apps/web/next.config.ts. These two do not overlap in the
// browser: the rewrites there exclude the proxied prefixes precisely so a response carries one
// set of headers, the one written by whichever side actually produced it.
export function registerSecurityHeaders(app: FastifyInstance) {
  app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        // A JSON response rendered inside a frame is still a clickjacking surface the moment a
        // browser is willing to render it as a document.
        "frame-ancestors": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
      },
    },
    // DENY, not helmet's SAMEORIGIN default: nothing in this deployment frames the API, and
    // "same origin" is exactly the reach an attacker gets through the UI's own rewrite.
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    // HSTS is the reverse proxy's to send, not this process's. Schrodump listens on plain HTTP by
    // design (docs/install.md) — a max-age emitted from here would be stripped by the proxy that
    // terminates TLS, or, on a deployment reached over HTTP, would pin a host the browser then
    // refuses to reach at all.
    strictTransportSecurity: false,
    // No page is served from this origin, so there is nothing to embed cross-origin and nothing
    // that needs a popup to stay same-origin. Both are cheap and neither costs the UI anything:
    // its calls arrive through the rewrite, server to server, where these headers do not apply.
    crossOriginResourcePolicy: { policy: "same-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
  });
}
