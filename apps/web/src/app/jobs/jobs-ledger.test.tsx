// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The ledger's header and chips read the server's counts over the whole table, never the page.
// The fixture holds ONE row and claims 1,284 in the table, so any number that came from the page
// would be a 1 or a 0 where the table says otherwise.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Job, JobList } from "@/lib/types";
import { JobsLedger } from "./page";

const NOW = new Date("2026-09-07T17:12:06.000Z");

const job: Job = {
  id: "job-1",
  policyId: "policy-1",
  targetName: "orders",
  policyName: "nightly",
  kind: "BACKUP",
  state: "SUCCEEDED",
  correlationId: "backup:cmtqofm340015nv7icksk39yj",
  scheduledAt: null,
  artifactId: null,
  startedAt: "2026-09-07T17:08:06.000Z",
  finishedAt: "2026-09-07T17:09:06.000Z",
  exitCode: 0,
  stderr: null,
  reason: null,
  artifact: { id: "cmtabcd1234567890", state: "UNOBSERVED" },
  restoreTarget: null,
  createdAt: "2026-09-07T17:08:06.000Z",
};

const list: JobList = {
  items: [job],
  total: 1284,
  counts: {
    byState: { PENDING: 3, RUNNING: 7, SUCCEEDED: 1200, FAILED: 60, INCONCLUSIVE: 4, CANCELLED: 10 },
    byKind: { BACKUP: 900, RESTORE: 12, VERIFY: 360, RETENTION: 12 },
  },
  stats: {
    oldestPendingScheduledAt: "2026-09-07T17:00:06.000Z",
    failedLast24h: 2,
    inconclusiveLast24h: 1,
  },
};

function renderLedger(data: JobList = list) {
  render(
    <I18nProvider>
      <JobsLedger list={data} now={NOW} />
    </I18nProvider>,
  );
}

describe("JobsLedger reads the table, not the page", () => {
  it("fills the tiles from the server's counts and stats", () => {
    renderLedger();
    const running = screen.getByText("Running now").closest("[data-tone]");
    expect(running).toHaveTextContent("7");
    // 17:00:06 → 17:12:06: the oldest pending job has waited twelve minutes, past the five that
    // turn a wait into a signal — the tile takes the caution tone.
    const queue = screen.getByText("In queue").closest("[data-tone]");
    expect(queue).toHaveTextContent("3");
    expect(queue).toHaveTextContent("longest 12m");
    expect(queue).toHaveAttribute("data-tone", "caution");
    const failed = screen.getByText("Failed · 24h").closest("[data-tone]");
    expect(failed).toHaveTextContent("2");
    expect(failed).toHaveAttribute("data-tone", "danger");
    // A verify that could not run is not a failure and is not painted like one.
    const inconclusive = screen.getByText("Could not run · 24h").closest("[data-tone]");
    expect(inconclusive).toHaveAttribute("data-tone", "quiet");
  });

  it("counts every chip over the whole table", () => {
    renderLedger();
    const state = screen.getByRole("group", { name: "State" });
    expect(state).toHaveTextContent("All1284");
    expect(state).toHaveTextContent("Running7");
    expect(state).toHaveTextContent("Could not run4");
    const kind = screen.getByRole("group", { name: "Kind" });
    expect(kind).toHaveTextContent("Verify360");
  });

  it("keeps the queue tile plain while the longest wait is under five minutes", () => {
    renderLedger({ ...list, stats: { ...list.stats, oldestPendingScheduledAt: "2026-09-07T17:10:06.000Z" } });
    const queue = screen.getByText("In queue").closest("[data-tone]");
    expect(queue).toHaveTextContent("longest 2m");
    expect(queue).toHaveAttribute("data-tone", "plain");
  });

  it("narrows the page with a filter and says so without pretending the page is the table", async () => {
    const user = userEvent.setup();
    renderLedger();
    expect(screen.getByText(/Showing the 1 most recent of 1284/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Failed/ }));
    expect(screen.getByText("No jobs match this filter.")).toBeInTheDocument();
    expect(screen.getByText("0 of the 1 newest rows match this filter · 1284 jobs in the table")).toBeInTheDocument();
    expect(screen.getByText("state Failed · all kinds · newest first")).toBeInTheDocument();
  });

  it("says which clock the times are on", () => {
    renderLedger();
    expect(screen.getByText(/Times in .+ · UTC[+−]\d{2}:\d{2}/)).toBeInTheDocument();
  });
});
