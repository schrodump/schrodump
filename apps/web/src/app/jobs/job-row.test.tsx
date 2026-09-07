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
