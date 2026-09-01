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
export function startLoop(opts: StartLoopOpts): { stop(): void; whenIdle(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (inFlight !== null || stopped) return;
    inFlight = Promise.resolve(opts.tick())
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  }, opts.intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    // Resolves when no tick is in flight. stop() first, then whenIdle(), to await a running tick
    // without a new one starting behind it.
    whenIdle() {
      return Promise.resolve(inFlight ?? undefined).then(() => undefined);
    },
  };
}

export interface ShutdownHandlers {
  onSignal(): Promise<void> | void;
}

// Installs SIGTERM/SIGINT. The handler stops claiming and releases resources before exit.
//
// `on`, NOT `once`, and the guard is what makes the difference. One `docker stop` delivers SIGTERM
// to this process TWICE: dumb-init broadcasts to the process group, and entrypoint.sh forwards it
// explicitly to each child. With `once`, the second arrival finds no listener and Node's default
// action terminates the process mid-cleanup — the executor container is orphaned, the cleartext
// scratch directory survives, and the job stays RUNNING until boot recovery. Measured against the
// built image: one signal completes the shutdown in 86ms; two never complete it at all.
//
// The escalation path is unchanged in practice. Repeated SIGTERM is now ignored while the first is
// unwinding, but `docker stop` escalates to SIGKILL after its grace period, and SIGKILL cannot be
// handled by anything — that is the real escalation, and it always was.
//
// `exit` is injectable so the duplicate-signal behaviour can be tested without the test runner
// exiting. It is not a production seam.
export function installShutdown(
  handlers: ShutdownHandlers,
  exit: () => void = () => process.exit(0),
): void {
  let shuttingDown = false;
  const handle = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // `.catch` BEFORE `.finally`, and the order is the point. `.finally` does not consume a
    // rejection — it re-throws it — so a shutdown sequence that fails would surface as an unhandled
    // rejection, whose default action races the very exit we are performing. Caught here so the
    // exit always wins; onSignal owns its own logging, and hanging until SIGKILL for a reason
    // nobody can see is worse than exiting with the work half-done.
    Promise.resolve(handlers.onSignal())
      .catch(() => undefined)
      .finally(exit);
  };
  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
}
