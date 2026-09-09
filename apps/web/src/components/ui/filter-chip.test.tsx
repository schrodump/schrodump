// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FilterChip } from "./filter-chip";

describe("FilterChip — a filter that is also a census", () => {
  it("always shows its count and says whether it is pressed", () => {
    render(<FilterChip label="UNOBSERVED" count={617} active state="UNOBSERVED" onClick={() => undefined} />);
    const chip = screen.getByRole("button", { name: /unobserved/i });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveTextContent("617");
    // A state filter speaks the rows' language: the state's own shape, not just its word.
    expect(chip.querySelector("[data-marker]")).toHaveAttribute("data-marker", "diamond");
  });

  it("carries no marker when it is not a state filter", () => {
    render(<FilterChip label="ALL" count="1,284" onClick={() => undefined} />);
    const chip = screen.getByRole("button", { name: /all/i });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip.querySelector("[data-marker]")).toBeNull();
  });
});
