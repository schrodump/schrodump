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

const nextConfig: NextConfig = {
  // The production image ships only traced files; without this the runtime would need the whole
  // node_modules of the app. Tracing is rooted at the monorepo, not at apps/web.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${server}/api/auth/:path*` },
      { source: "/backend/:path*", destination: `${server}/:path*` },
    ];
  },
};

export default nextConfig;
