// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The trail the server kept and never showed. A row has to name the actor without inventing one:
// a job's credential read has no user, and "system" is the honest word for it — never a blank that
// reads as missing data, never a fabricated email.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { AuditEntry } from "@/lib/types";
import { AuditRow } from "./page";

const base: AuditEntry = {
  id: "a1",
  action: "restore.execute",
  targetType: "artifacts",
  targetId: "cmtartifact1234",
  correlationId: "restore:cmtartifact1234",
  actorEmail: "admin@example.com",
  createdAt: "2026-09-03T15:14:00.000Z",
};

function renderRow(entry: AuditEntry) {
  render(
    <I18nProvider>
      <AuditRow entry={entry} />
    </I18nProvider>,
  );
}

describe("AuditRow", () => {
  // Exact matches, so each assertion pins the leaf span and never the row div that contains them all.
  it("names the action and the person who did it", () => {
    renderRow(base);
    expect(screen.getByText("restore.execute")).toBeInTheDocument();
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });

  it("says 'system' for an action with no actor (a job's credential read), never a blank", () => {
    renderRow({ ...base, action: "credential.read", actorEmail: null, correlationId: "backup:p1" });
    expect(screen.getByText("system")).toBeInTheDocument();
  });

  it("shows the target it acted on", () => {
    renderRow(base);
    expect(screen.getByText("artifacts:cmtartif")).toBeInTheDocument();
  });
});
