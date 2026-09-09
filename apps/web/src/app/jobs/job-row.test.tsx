// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The ledger row: what the run was about, how it went, and the verdict on the data it touched.
// Copy is asserted through the English catalog; a text that appears twice (the summary cell and
// the fact below it) is asserted with getAllByText — both are on purpose, the row and its detail.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Job } from "@/lib/types";
import { JobRow } from "./page";

const NOW = new Date("2026-09-07T17:12:06.000Z");

const base: Job = {
  id: "job-1",
  policyId: "policy-1",
  targetName: null,
  policyName: null,
  kind: "BACKUP",
  state: "RUNNING",
  correlationId: "backup:cmtqofm340015nv7icksk39yj",
  scheduledAt: null,
  artifactId: null,
  startedAt: "2026-09-07T17:08:06.000Z",
  finishedAt: null,
  exitCode: null,
  stderr: null,
  reason: null,
  artifact: null,
  restoreTarget: null,
  createdAt: "2026-09-07T17:08:06.000Z",
};

function renderRow(job: Job, now: Date = NOW) {
  render(
    <I18nProvider>
      <JobRow job={job} now={now} />
    </I18nProvider>,
  );
}

describe("JobRow says what the job is about", () => {
  it("names the database being read", () => {
    renderRow({ ...base, targetName: "ZapYou Inc", policyName: "ZapYou Backup" });
    expect(screen.getByText("ZapYou Inc")).toBeTruthy();
  });

  it("names the policy too, when it says something the target does not", () => {
    renderRow({ ...base, targetName: "orders", policyName: "nightly" });
    expect(screen.getByText("policy nightly")).toBeTruthy();
  });

  it("does not print the same name twice when the policy is named after its target", () => {
    // The common case, and the reason this is not just two unconditional spans: a row reading
    // "IPOG 1  IPOG 1" looks like a rendering bug rather than like information.
    renderRow({ ...base, targetName: "IPOG 1", policyName: "IPOG 1" });
    expect(screen.getAllByText(/IPOG 1/)).toHaveLength(1);
  });

  it("renders a job whose policy is gone without inventing a name for it", () => {
    // Null is absence, not a placeholder. A deleted policy leaves jobs behind, and "unknown" on the
    // row would be indistinguishable from a policy actually called that.
    renderRow(base);
    expect(screen.queryByText(/unknown|desconhec/i)).toBeNull();
    expect(screen.getAllByText(/backup:cmtqofm/i).length).toBeGreaterThan(0);
  });

  it("calls a run with no policy and no schedule what it is: manual", () => {
    renderRow({ ...base, policyId: null, scheduledAt: null });
    expect(screen.getByText("manual run")).toBeInTheDocument();
    expect(screen.getByText("manual run — no schedule")).toBeInTheDocument();
  });
});

describe("JobRow says how the job went", () => {
  it("shows how long a finished job ran (92s → 1m 32s)", () => {
    renderRow({
      ...base,
      state: "SUCCEEDED",
      startedAt: "2026-09-07T17:08:00.000Z",
      finishedAt: "2026-09-07T17:09:32.000Z",
    });
    expect(screen.getByText("ran in 1m 32s")).toBeInTheDocument();
  });

  it("shows the queue wait when a scheduled job started late", () => {
    renderRow({
      ...base,
      state: "SUCCEEDED",
      scheduledAt: "2026-09-07T02:00:00.000Z",
      startedAt: "2026-09-07T02:00:45.000Z",
      finishedAt: "2026-09-07T02:01:00.000Z",
    });
    expect(screen.getByText("waited 45s in queue")).toBeInTheDocument();
  });

  it("says the workers are behind when the wait passed five minutes", () => {
    renderRow({
      ...base,
      state: "SUCCEEDED",
      scheduledAt: "2026-09-07T02:00:00.000Z",
      startedAt: "2026-09-07T02:06:00.000Z",
      finishedAt: "2026-09-07T02:07:00.000Z",
    });
    expect(screen.getByText("waited 6m in queue · workers behind")).toBeInTheDocument();
  });

  it("ticks a running job's elapsed time from the clock it is given", () => {
    // 17:08:06 → 17:12:06 is four minutes; the page hands the row a ticking clock so the row
    // itself needs no timer to test.
    renderRow(base);
    expect(screen.getByText("running 4m")).toBeInTheDocument();
  });

  it("shows how long a pending job has waited, and flags one nobody claimed in five minutes", () => {
    renderRow({ ...base, state: "PENDING", startedAt: null, scheduledAt: "2026-09-07T17:06:06.000Z" });
    expect(screen.getByText("waiting 6m")).toBeInTheDocument();
    expect(screen.getByText("in queue · not claimed yet")).toBeInTheDocument();
  });

  it("shows a non-zero exit code", () => {
    renderRow({ ...base, state: "FAILED", exitCode: 1, finishedAt: base.startedAt });
    expect(screen.getByText(/exit 1/i)).toBeInTheDocument();
  });

  it("stays quiet on exit 0 — the normal case is not clutter", () => {
    renderRow({ ...base, state: "SUCCEEDED", exitCode: 0, finishedAt: base.startedAt });
    expect(screen.queryByText(/exit 0/i)).toBeNull();
  });
});

// A job state is a process outcome. The verdict on the data lives on the artifact, and the row
// shows it beside every reference — in the artifact's own colour and shape, never borrowed.
describe("JobRow shows the verdict on the data", () => {
  it("points at the artifact a verify acted on, with its state", () => {
    renderRow({ ...base, kind: "VERIFY", artifact: { id: "cmtabcd1234567890", state: "UNOBSERVED" } });
    expect(screen.getAllByText(/cmtabcd1/).length).toBeGreaterThan(0);
    const badge = screen.getByText("Unobserved").closest("[data-artifact-state]");
    expect(badge).toHaveAttribute("data-artifact-state", "UNOBSERVED");
  });

  it("flags a verify the worker downgraded to a checksum, and says why the check was shallower", () => {
    renderRow({
      ...base,
      kind: "VERIFY",
      state: "SUCCEEDED",
      finishedAt: base.startedAt,
      reason: "sealed destination: FULL_RESTORE downgraded to CHECKSUM",
      artifact: { id: "cmtabcd1234567890", state: "VERIFIED" },
    });
    expect(screen.getByTestId("job-downgraded")).toHaveTextContent(/checksum ↓ downgraded/);
    expect(screen.getByText("Why the check was shallower")).toBeInTheDocument();
  });

  it("labels a failed run's reason as why it failed", () => {
    renderRow({ ...base, state: "FAILED", finishedAt: base.startedAt, reason: "backup destination unavailable" });
    expect(screen.getByText("Why it failed")).toBeInTheDocument();
    expect(screen.getByText("backup destination unavailable")).toBeInTheDocument();
  });

  it("says a verify that could not run left the artifact exactly as it found it", () => {
    renderRow({
      ...base,
      kind: "VERIFY",
      state: "INCONCLUSIVE",
      finishedAt: base.startedAt,
      reason: "verify inconclusive: the sandbox could not run — artifact unchanged",
      artifact: { id: "cmtabcd1234567890", state: "UNOBSERVED" },
    });
    expect(screen.getByText("Why nothing was concluded")).toBeInTheDocument();
    expect(screen.getByText("unchanged — still Unobserved")).toBeInTheDocument();
  });

  it("names a restore's scope", () => {
    renderRow({
      ...base,
      kind: "RESTORE",
      state: "SUCCEEDED",
      finishedAt: base.startedAt,
      restoreTarget: "DATABASE",
      artifact: { id: "cmtabcd1234567890", state: "VERIFIED" },
    });
    expect(screen.getByText("Restore scope")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
  });

  it("offers the execution log only when there is one", () => {
    renderRow({ ...base, state: "FAILED", finishedAt: base.startedAt, stderr: "pg_dump: error: x\nWARN slow" });
    expect(screen.getByText("2 lines")).toBeInTheDocument();
    expect(screen.getByText("WARN slow")).toBeInTheDocument();
  });

  it("shows no log control for a run that captured nothing", () => {
    renderRow({ ...base, state: "SUCCEEDED", finishedAt: base.startedAt });
    expect(screen.queryByText(/Execution log/)).toBeNull();
  });
});
