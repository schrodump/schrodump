// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert, AlertTitle } from "./alert";
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

  it("Alert keeps role=alert and maps warning onto the caution tone", () => {
    render(
      <Alert variant="warning">
        <AlertTitle>Verify is off for this policy</AlertTitle>
      </Alert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-tone", "warning");
    expect(alert.className).toContain("caution");
  });
});
