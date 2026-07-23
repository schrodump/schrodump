// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { NextConfig } from "next";

// The web talks to the server through same-origin rewrites so the Better-Auth session cookie is
// same-origin (no CORS, no server change). SCHRODUMP_API_URL points at apps/server.
const server = process.env.SCHRODUMP_API_URL ?? "http://localhost:8080";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${server}/api/auth/:path*` },
      { source: "/backend/:path*", destination: `${server}/:path*` },
    ];
  },
};

export default nextConfig;
