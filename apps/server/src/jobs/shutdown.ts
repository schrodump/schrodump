// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export interface GracefulShutdownDeps {
  handle: { stop(): void; whenIdle(): Promise<void> };
  scheduler: { stop(): void };
  controller: { abort(reason?: unknown): void };
  disconnect(): Promise<void>;
  graceMs: number;
  log: { info(obj: Record<string, unknown>, msg: string): void };
}

// Ordered shutdown: stop claiming, abort the in-flight run (the runner force-kills its container →
// run() rejects → executor finally releases the scratch dir → runWorkerOnce marks the job FAILED),
// await the tick settling but never past graceMs, then drop the advisory-lock connection. A drain
// that outlasts the grace falls through to the boot-time backstop (orphan recovery + scratch sweep).
export async function runGracefulShutdown(deps: GracefulShutdownDeps): Promise<void> {
  deps.log.info({}, "shutdown: stopping loops");
  deps.handle.stop();
  deps.scheduler.stop();
  deps.controller.abort(new Error("shutdown"));
  // Clear the grace timer when whenIdle() wins, so a resolved shutdown never leaves an 8s timer
  // pending (which would keep the event loop alive and delay a clean exit).
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, deps.graceMs);
  });
  await Promise.race([deps.handle.whenIdle(), grace]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  await deps.disconnect();
  deps.log.info({}, "shutdown: complete");
}
