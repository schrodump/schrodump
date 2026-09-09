// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The trail, grouped by the viewer's day and narrowed by action or actor — with the footer saying
// what a filter narrowed (the page) and what the table holds, never conflating the two.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { AuditEntry, AuditList } from "@/lib/types";
import { AuditLedger } from "./page";

const NOW = new Date(2026, 8, 8, 12, 0);
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: over.correlationId ?? "x",
  action: "policy.update",
  targetType: "policy",
  targetId: "pol31abcccc",
  correlationId: "req:1",
  actorEmail: "ops@example.test",
  createdAt: at(1),
  ...over,
});

const list: AuditList = {
  items: [
    entry({ correlationId: "req:1", action: "policy.update", createdAt: at(1) }),
    entry({ correlationId: "backup:2", action: "target.credential.read", actorEmail: null, createdAt: at(2) }),
    entry({ correlationId: "req:3", action: "artifact.delete", actorEmail: "diego@example.test", createdAt: at(30) }),
  ],
  total: 8412,
};

function renderLedger() {
  render(
    <I18nProvider>
      <AuditLedger list={list} now={NOW} />
    </I18nProvider>,
  );
  return userEvent.setup();
}

describe("AuditLedger", () => {
  it("groups entries by the viewer's day, newest first, and counts each group", () => {
    renderLedger();
    const groups = screen.getAllByRole("region");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Today", "Yesterday"]);
    expect(groups[0]).toHaveTextContent("2 entries");
    expect(groups[1]).toHaveTextContent("1 entry");
  });

  it("says the page is the newest slice of a larger table", () => {
    renderLedger();
    expect(screen.getByText(/Showing the 3 most recent of 8412/)).toBeInTheDocument();
  });

  it("narrows by actor — system is a job's own credential read — and says so honestly", async () => {
    const user = renderLedger();
    await user.selectOptions(screen.getByRole("combobox", { name: "Actor" }), "system");
    // Scoped to the rows: the filter's own options carry the same words.
    const rows = within(screen.getByRole("region", { name: "Today" }));
    expect(rows.getByText("target.credential.read")).toBeInTheDocument();
    expect(rows.queryByText("policy.update")).toBeNull();
    expect(screen.getByText("1 of the 3 newest entries match this filter · 8412 entries in the table")).toBeInTheDocument();
  });

  it("narrows by action", async () => {
    const user = renderLedger();
    await user.selectOptions(screen.getByRole("combobox", { name: "Action" }), "artifact.delete");
    const rows = within(screen.getByRole("region", { name: "Yesterday" }));
    expect(rows.getByText("diego@example.test")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Today" })).toBeNull();
  });
});
