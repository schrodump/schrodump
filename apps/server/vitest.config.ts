// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The gated FULL_RESTORE smokes (full-restore-verify + mysql-mongo-full-restore-verify) share
    // ONE Docker daemon, and each asserts — via a GLOBAL `docker ps -aq` before/after diff — that the
    // verify sandbox leaves no container behind. With files running in parallel (vitest's default),
    // one smoke file's short-lived executor/sandbox containers land in another file's diff window and
    // register as a false leak (a sibling file's container id, not one this test created). Serialize
    // files ONLY under the integration gate, where the leak assertions actually run; the default unit
    // run stays fully parallel. Cross-project pollution can't happen: pnpm -r runs apps/server after
    // its package deps (topological), so the runner/engines/storage integration tests are already done.
    fileParallelism: process.env.SCHRODUMP_TEST_INTEGRATION !== "1",
  },
  resolve: {
    // @schrodump/<pkg>/<subpath> -> ../../packages/<pkg>/src/<subpath>.ts (resolve from source)
    alias: [{ find: /^@schrodump\/([^/]+)\/(.*)$/, replacement: `${packagesDir}$1/src/$2.ts` }],
  },
});
