// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { defineConfig } from "vitest/config";

// Shared base config. ESM-native, no transform layer — packages extend this
// via `mergeConfig` in their own vitest.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.{test,spec}.ts"],
  },
});
