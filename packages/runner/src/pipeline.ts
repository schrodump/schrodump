// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { pipeline } from "node:stream/promises";
import type { Duplex, Readable, Writable } from "node:stream";

// Composes STREAM-mode output: container stdout -> compression -> encryption -> destination.
//
// The runner does NOT know the destination — the caller (apps/server) supplies the final
// Writable (the storage upload). This keeps the storage boundary out of the runner.
//
// Uses node:stream/promises pipeline() rather than chained .pipe(): an error in ANY stage
// aborts the whole chain and rejects, instead of being dropped silently — the classic source
// of "backup succeeded" on a broken stream.
export function composeStreamPipeline(
  source: Readable,
  stages: Duplex[],
  destination: Writable,
): Promise<void> {
  return pipeline([source, ...stages, destination]);
}
