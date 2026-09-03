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

describe("StatusBadge — state survives without colour", () => {
  // Colour alone fails anyone who cannot separate the hues, and fails everyone in greyscale. Each
  // state carries a distinct shape as well, and the marker is a real element rather than a
  // ::before, so this property is assertable instead of merely intended.
  it.each([
    ["VERIFIED", "disc"],
    ["UNOBSERVED", "diamond"],
    ["FAILED", "triangle"],
  ] as const)("marks %s with a %s", (state, shape) => {
    renderBadge(state);
    const badge = screen.getByTestId(`state-${state}`);
    const marker = badge.querySelector("[data-marker]");
    expect(marker).toHaveAttribute("data-marker", shape);
  });

  it("gives the three states three different shapes, not one repeated", () => {
    const shapes = new Set<string>();
    for (const state of ["VERIFIED", "UNOBSERVED", "FAILED"] as const) {
      const { container, unmount } = renderBadge(state);
      shapes.add(container.querySelector("[data-marker]")?.getAttribute("data-marker") ?? "");
      unmount();
    }
    expect(shapes.size).toBe(3);
  });

  it("hides the marker from assistive tech — the label already says the state", () => {
    renderBadge("UNOBSERVED");
    expect(screen.getByTestId("state-UNOBSERVED").querySelector("[data-marker]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

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
