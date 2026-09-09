// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailGrid } from "./detail-grid";

describe("DetailGrid — a null is an absence", () => {
  it("drops a fact with no value instead of rendering an empty slot", () => {
    render(
      <DetailGrid
        facts={[
          { label: "Queue wait", value: "5m 12s" },
          { label: "Dependencies", value: null },
          { label: "Runner", value: "" },
        ]}
      />,
    );
    expect(screen.getByText("Queue wait")).toBeInTheDocument();
    expect(screen.getByText("5m 12s")).toBeInTheDocument();
    expect(screen.queryByText("Dependencies")).toBeNull();
    expect(screen.queryByText("Runner")).toBeNull();
  });

  it("tones a value without changing what it says", () => {
    render(<DetailGrid facts={[{ label: "Artifact after this run", value: "unchanged", tone: "caution" }]} />);
    expect(screen.getByText("unchanged").className).toContain("caution");
  });
});
