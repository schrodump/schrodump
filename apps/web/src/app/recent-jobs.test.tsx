// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The dashboard's job list showed kind, state and the correlationId — an opaque internal string —
// and dropped `reason`, which is the field that says WHAT HAPPENED. On the running deployment the
// reasons read "verify level NONE — artifact remains UNOBSERVED" and "a DATABASE restore of this
// mariadb artifact cannot be confined…", and neither of them reached the screen.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Job } from "@/lib/types";
import { RecentJobs } from "./page";

const base: Job = {
  id: "j1",
  policyId: null,
  kind: "VERIFY",
  state: "SUCCEEDED",
  correlationId: "verify:cmtlo0o9t004mk62i3vwh9ynz",
  startedAt: "2026-09-03T15:14:00.000Z",
  finishedAt: "2026-09-03T15:14:20.000Z",
  exitCode: 0,
  stderr: null,
  reason: "verify level NONE — artifact remains UNOBSERVED",
  createdAt: "2026-09-03T15:14:00.000Z",
};

function renderJobs(jobs: Job[]) {
  return render(
    <I18nProvider>
      <RecentJobs jobs={jobs} />
    </I18nProvider>,
  );
}

describe("RecentJobs", () => {
  it("says what happened, which is the reason", () => {
    renderJobs([base]);
    expect(screen.getByText(/artifact remains UNOBSERVED/)).toBeInTheDocument();
  });

  it("still names the kind and the state", () => {
    // Scoped to their own cells: /verify/i alone also matches the reason text on this very row,
    // which would make the assertion pass without either label being rendered at all.
    renderJobs([base]);
    const row = screen.getByTestId("job-state-j1").parentElement;
    expect(row?.firstElementChild).toHaveTextContent(/^verify$/i);
    expect(screen.getByTestId("job-state-j1")).toHaveTextContent(/^succeeded$/i);
  });

  it("does not spend the row on an internal correlation id", () => {
    // It belongs on the jobs screen, where someone is chasing one job. On a dashboard it is a
    // sixty-character string occupying the place the explanation should be.
    renderJobs([base]);
    expect(screen.queryByText(/cmtlo0o9t004mk62i3vwh9ynz/)).toBeNull();
  });

  it("marks a failed job as failed, and leaves a succeeded one uncoloured", () => {
    // Job state is not artifact state and must not borrow its colour language: a job that
    // succeeded says nothing about whether a backup is good.
    renderJobs([
      { ...base, id: "j2", kind: "RESTORE", state: "FAILED", reason: "cannot be confined" },
    ]);
    expect(screen.getByTestId("job-state-j2")).toHaveAttribute("data-failed", "true");
    renderJobs([base]);
    expect(screen.getByTestId("job-state-j1")).toHaveAttribute("data-failed", "false");
  });

  it("renders a job with no reason without inventing one", () => {
    renderJobs([{ ...base, id: "j3", reason: null }]);
    expect(screen.getByTestId("job-state-j3")).toBeInTheDocument();
  });
});
