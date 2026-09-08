// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What an operator can tell about a running job by looking at it.
//
// The row showed kind, state and a correlation ID. Watching two backups run at once, there was no
// way to tell which database each was reading — the answer was a cuid embedded in that ID, and the
// name it pointed at was never fetched.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Job } from "@/lib/types";
import { JobRow } from "./page";

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
  createdAt: "2026-09-07T17:08:06.000Z",
};

function renderRow(job: Job) {
  render(
    <I18nProvider>
      <JobRow job={job} />
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
    expect(screen.getByText("nightly")).toBeTruthy();
  });

  it("does not print the same name twice when the policy is named after its target", () => {
    // The common case, and the reason this is not just two unconditional spans: a row reading
    // "IPOG 1  IPOG 1" looks like a rendering bug rather than like information.
    renderRow({ ...base, targetName: "IPOG 1", policyName: "IPOG 1" });
    expect(screen.getAllByText("IPOG 1")).toHaveLength(1);
  });

  it("renders a job whose policy is gone without inventing a name for it", () => {
    // Null is absence, not a placeholder. A deleted policy leaves jobs behind, and "unknown" on the
    // row would be indistinguishable from a policy actually called that.
    renderRow(base);
    expect(screen.queryByText(/unknown|desconhec/i)).toBeNull();
    expect(screen.getByText(/backup:cmtqofm/i)).toBeTruthy();
  });
});

// The timing the row used to drop: how long it ran, how long it waited to start, its exit code, and
// what artifact it acted on.
describe("JobRow says how the job went", () => {
  it("shows how long a finished job ran (92s → 1m 32s)", () => {
    renderRow({
      ...base,
      state: "SUCCEEDED",
      startedAt: "2026-09-07T17:08:00.000Z",
      finishedAt: "2026-09-07T17:09:32.000Z",
    });
    expect(screen.getByText(/1m 32s/)).toBeInTheDocument();
  });

  it("shows the queue wait when a scheduled job started late", () => {
    renderRow({
      ...base,
      state: "SUCCEEDED",
      scheduledAt: "2026-09-07T02:00:00.000Z",
      startedAt: "2026-09-07T02:00:45.000Z",
      finishedAt: "2026-09-07T02:01:00.000Z",
    });
    expect(screen.getByText(/45s in queue|queue/i)).toBeInTheDocument();
  });

  it("shows a non-zero exit code", () => {
    renderRow({ ...base, state: "FAILED", exitCode: 1, finishedAt: base.startedAt });
    expect(screen.getByText(/exit 1/i)).toBeInTheDocument();
  });

  it("stays quiet on exit 0 — the normal case is not clutter", () => {
    renderRow({ ...base, state: "SUCCEEDED", exitCode: 0, finishedAt: base.startedAt });
    expect(screen.queryByText(/exit 0/i)).toBeNull();
  });

  it("points at the artifact a verify acted on", () => {
    renderRow({ ...base, kind: "VERIFY", artifactId: "cmtabcd1234567890" });
    expect(screen.getByText(/cmtabcd1/)).toBeInTheDocument();
  });
});
