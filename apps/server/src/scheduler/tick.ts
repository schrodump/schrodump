// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The scheduler tick runs several passes under one advisory lock: dispatch, then the fleet
// notifications, then the job-event outbox. They share the lock and the cadence, and nothing else.
//
// They used to share a callback too, with dispatch awaited first and outside any catch of its own.
// A dispatch that threw — one unparseable cron was enough — ended the callback there, and the two
// notification passes never ran: the product went quiet about the very tick on which it stopped
// scheduling backups. Each pass is now its own attempt, logged under its own line, and a pass that
// throws cannot take the ones after it down with it.

export interface TickPass {
  // The log line when this pass throws — the one an operator greps for.
  readonly failure: string;
  run(): Promise<unknown>;
}

export async function runTickPasses(
  passes: readonly TickPass[],
  log: { error(o: Record<string, unknown>, m: string): void },
): Promise<void> {
  for (const pass of passes) {
    try {
      await pass.run();
    } catch (err) {
      log.error({ err }, pass.failure);
    }
  }
}
