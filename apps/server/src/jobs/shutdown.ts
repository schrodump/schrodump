// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export interface GracefulShutdownDeps {
  handle: { stop(): void; whenIdle(): Promise<void> };
  scheduler: { stop(): void };
  // Present only when self-backup is configured. Unlike the scheduler — whose tick is a short
  // dispatch — a self-backup tick holds an executor container and a multipart upload, so it is
  // awaited alongside the worker drain rather than merely stopped.
  selfBackup?: { stop(): void; whenIdle(): Promise<void> };
  controller: { abort(reason?: unknown): void };
  disconnect(): Promise<void>;
  graceMs: number;
  log: { info(obj: Record<string, unknown>, msg: string): void };
}

// Ordered shutdown: stop claiming, abort the in-flight run (the runner force-kills its container →
// run() rejects → executor finally releases the scratch dir → runWorkerOnce marks the job FAILED),
// await the tick settling but never past graceMs, then drop the advisory-lock connection. A drain
// that outlasts the grace falls through to the boot-time backstop (orphan recovery + scratch sweep).
// Bounds the advisory-lock disconnect. The grace below covers the drain; without this the disconnect
// after it is unbounded, so a wedged connection could still hold the process past the docker stop
// window the whole feature is budgeted against. The lock is session-scoped — if the disconnect never
// lands, the socket dies with the process and PostgreSQL releases it anyway.
const DISCONNECT_GRACE_MS = 2000;

export async function runGracefulShutdown(deps: GracefulShutdownDeps): Promise<void> {
  deps.log.info({}, "shutdown: stopping loops");
  deps.handle.stop();
  deps.scheduler.stop();
  deps.selfBackup?.stop();
  deps.controller.abort(new Error("shutdown"));
  // Clear the grace timer when whenIdle() wins, so a resolved shutdown never leaves an 8s timer
  // pending (which would keep the event loop alive and delay a clean exit).
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, deps.graceMs);
  });
  const idle = Promise.all([
    deps.handle.whenIdle(),
    deps.selfBackup?.whenIdle() ?? Promise.resolve(),
  ]);
  await Promise.race([idle, grace]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  // Still attempted on every path, including grace expiry — dropping the session lock promptly is
  // the point — but no longer able to outlast it.
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const disconnectGrace = new Promise<void>((resolve) => {
    disconnectTimer = setTimeout(resolve, DISCONNECT_GRACE_MS);
  });
  await Promise.race([deps.disconnect(), disconnectGrace]);
  if (disconnectTimer !== undefined) clearTimeout(disconnectTimer);
  deps.log.info({}, "shutdown: complete");
}
