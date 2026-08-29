// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

export interface StartLoopOpts {
  // The periodic work. Its resolved value is ignored — the loop only awaits it to guard overlap.
  tick: () => Promise<unknown>;
  intervalMs: number;
}

// Runs `tick` on an interval. Re-entrancy guarded so a slow tick never overlaps the next one.
// stop() halts further ticks; an in-flight tick finishes on its own — whenIdle() is how a caller
// (the shutdown sequence) waits for it. Shared by the worker drain and the scheduler dispatch —
// both are "run this async work on an interval, single-flight".
export function startLoop(opts: StartLoopOpts): { stop(): void; whenIdle(): Promise<void> } {
  let stopped = false;
  // The in-flight tick, or null when idle. Doubles as the re-entrancy guard the boolean used to be.
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight !== null || stopped) return;
    inFlight = Promise.resolve(opts.tick())
      .then(
        () => undefined,
        () => undefined, // a tick's own failure is the tick's business; the loop keeps its shape
      )
      .finally(() => {
        inFlight = null;
      });
  }, opts.intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    // Resolves when no tick is running. Never rejects: a tick that threw is still a tick that
    // finished, and shutdown must not be derailed by the failure of the work it is waiting out.
    whenIdle() {
      return inFlight ?? Promise.resolve();
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
