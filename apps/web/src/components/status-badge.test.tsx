// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { ArtifactState } from "@/lib/domain";
import { StatusBadge } from "./status-badge";

function renderBadge(state: ArtifactState) {
  return render(
    <I18nProvider>
      <StatusBadge state={state} />
    </I18nProvider>,
  );
}

describe("StatusBadge", () => {
  it("renders VERIFIED in green", () => {
    renderBadge("VERIFIED");
    const badge = screen.getByText("Verified");
    expect(badge).toHaveAttribute("data-state", "VERIFIED");
    expect(badge.className).toContain("state-verified");
  });

  it("renders UNOBSERVED in amber — never green, never OK", () => {
    renderBadge("UNOBSERVED");
    const badge = screen.getByText("Unobserved");
    expect(badge).toHaveAttribute("data-state", "UNOBSERVED");
    expect(badge.className).toContain("state-unobserved");
    // The whole point: an unverified backup is never styled green nor labelled OK.
    expect(badge.className).not.toContain("state-verified");
    expect(badge).not.toHaveTextContent(/ok/i);
  });

  it("renders FAILED in red", () => {
    renderBadge("FAILED");
    const badge = screen.getByText("Failed");
    expect(badge).toHaveAttribute("data-state", "FAILED");
    expect(badge.className).toContain("state-failed");
  });
});
