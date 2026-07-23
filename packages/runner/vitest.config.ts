// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve @schrodump/core from source so tests run without building the core package.
const coreSrc = fileURLToPath(new URL("../core/src/", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: [{ find: /^@schrodump\/core\/(.*)$/, replacement: `${coreSrc}$1.ts` }],
  },
});
