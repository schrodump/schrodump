// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    // @schrodump/<pkg>/<subpath> -> ../../packages/<pkg>/src/<subpath>.ts (resolve from source)
    alias: [{ find: /^@schrodump\/([^/]+)\/(.*)$/, replacement: `${packagesDir}$1/src/$2.ts` }],
  },
});
