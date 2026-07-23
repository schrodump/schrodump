// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { main } from "./server.js";

main().catch((error: unknown) => {
  // Boot-time fatal (env, KEK fingerprint mismatch, DB unreachable): fail loudly and exit.
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  process.exit(1);
});
