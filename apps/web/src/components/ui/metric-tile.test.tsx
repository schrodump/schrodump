// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricTile } from "./metric-tile";

describe("MetricTile", () => {
  it("shows the number with its name, unit line and note", () => {
    render(<MetricTile label="In queue" value="3" sub="longest 12m" note="How far behind the workers are." />);
    expect(screen.getByText("In queue")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("longest 12m")).toBeInTheDocument();
    expect(screen.getByText("How far behind the workers are.")).toBeInTheDocument();
  });

  it("carries its tone as data, so the meaning is inspectable, and defaults to plain", () => {
    const { rerender } = render(<MetricTile label="Failed" value="2" tone="danger" />);
    expect(screen.getByText("Failed").closest("[data-tone]")).toHaveAttribute("data-tone", "danger");
    rerender(<MetricTile label="Failed" value="0" />);
    expect(screen.getByText("Failed").closest("[data-tone]")).toHaveAttribute("data-tone", "plain");
  });

  it("drops an empty unit line instead of leaving a blank span", () => {
    render(<MetricTile label="Running now" value="0" sub="" />);
    expect(screen.getByText("0").parentElement?.childElementCount).toBe(1);
  });
});
