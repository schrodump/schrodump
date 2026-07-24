// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export interface StartWorkerOpts {
  drainQueue: () => Promise<number>;
  intervalMs: number;
}

// Polls on an interval, draining the queue each tick. Re-entrancy guarded so a slow drain never
// overlaps the next tick. stop() halts further ticks; an in-flight drain finishes on its own.
export function startWorker(opts: StartWorkerOpts): { stop(): void } {
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void opts
      .drainQueue()
      .catch(() => 0)
      .finally(() => {
        running = false;
      });
  }, opts.intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export interface ShutdownHandlers {
  onSignal(): Promise<void> | void;
}

// Installs SIGTERM/SIGINT once. The handler stops claiming and releases resources before exit.
export function installShutdown(handlers: ShutdownHandlers): void {
  let shuttingDown = false;
  const handle = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.resolve(handlers.onSignal()).finally(() => process.exit(0));
  };
  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
}
