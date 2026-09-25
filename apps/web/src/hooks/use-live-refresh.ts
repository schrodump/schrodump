// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useSyncExternalStore } from "react";
import type { JobList } from "@/lib/types";

// Nothing on these screens refreshed itself. A job that finished at one minute kept counting
// "running 47m" under a clock that ticked every second, and an artifact stayed amber long after the
// verify had turned it green — the operator only found out by pressing F5. A live clock over stale
// data is worse than no clock: it asserts a freshness the screen does not have.
//
// The cadence follows the work, not the wall clock. While a job is PENDING or RUNNING the screen is
// an instrument and refreshes every few seconds; with nothing in flight it is a record, and a slow
// poll is enough to notice a scheduled run appearing. A hidden tab polls at neither rate — nobody
// is reading it, and a closed laptop lid should not keep a browser talking to the server.
export const LIVE_POLL_MS = 4_000;
export const IDLE_POLL_MS = 30_000;

// Read from the server's counts over the WHOLE table, never from `items.length`: the list is capped
// at two hundred rows, and the page is not the table. It is the same law the ledger's tiles and
// chips follow — a screen that decided it was idle because the running job fell off the page would
// go quiet at exactly the moment it must not.
export function workInFlight(jobs: JobList | undefined): boolean {
  if (jobs === undefined) return false;
  return jobs.counts.byState.RUNNING + jobs.counts.byState.PENDING > 0;
}

// `false` is TanStack's "no interval", not a zero — the timer is torn down rather than run fast.
export function pollInterval(visible: boolean, inFlight: boolean): number | false {
  if (!visible) return false;
  return inFlight ? LIVE_POLL_MS : IDLE_POLL_MS;
}

function subscribeVisibility(onStoreChange: () => void): () => void {
  document.addEventListener("visibilitychange", onStoreChange);
  return () => document.removeEventListener("visibilitychange", onStoreChange);
}

// `visibilityState !== "hidden"` rather than `=== "visible"`: "prerender" is not a reader either,
// but it is also not a tab someone closed the lid on, and treating it as visible costs one request.
// The server snapshot is `true` — the markup Next renders has no document to ask, and a client that
// hydrates hidden corrects itself on the first `visibilitychange`.
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}
