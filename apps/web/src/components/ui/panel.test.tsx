// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Panel } from "./panel";

describe("Panel — tone carries the meaning", () => {
  it("does not paint a lock red: a constraint is not a failure", () => {
    render(<Panel tone="lock">Whole instance</Panel>);
    const panel = screen.getByText("Whole instance");
    expect(panel).toHaveAttribute("data-tone", "lock");
    expect(panel.className).not.toContain("destructive");
  });

  it("paints danger and error with the destructive tint", () => {
    render(
      <>
        <Panel tone="danger">reaches the bucket</Panel>
        <Panel tone="error">nothing was filled in</Panel>
      </>,
    );
    expect(screen.getByText("reaches the bucket").className).toContain("destructive");
    expect(screen.getByText("nothing was filled in").className).toContain("destructive");
  });

  it("a panel that must be announced takes role=alert itself, in the caution tone", () => {
    render(
      <Panel tone="warning" role="alert">
        Verify is off for this policy
      </Panel>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-tone", "warning");
    expect(alert.className).toContain("caution");
  });
});
