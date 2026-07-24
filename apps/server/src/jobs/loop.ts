// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export interface StartLoopOpts {
  // The periodic work. Its resolved value is ignored — the loop only awaits it to guard overlap.
  tick: () => Promise<unknown>;
  intervalMs: number;
}

// Runs `tick` on an interval. Re-entrancy guarded so a slow tick never overlaps the next one.
// stop() halts further ticks; an in-flight tick finishes on its own. Shared by the worker drain
// and the scheduler dispatch — both are "run this async work on an interval, single-flight".
export function startLoop(opts: StartLoopOpts): { stop(): void } {
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void Promise.resolve(opts.tick())
      .catch(() => undefined)
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
