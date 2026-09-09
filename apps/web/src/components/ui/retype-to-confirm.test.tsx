// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RetypeToConfirm } from "./retype-to-confirm";

describe("RetypeToConfirm — the match is exact, the error is inline", () => {
  it("reports a mismatch only once something has been typed", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RetypeToConfirm id="c" label="Retype the id" subject="art_7412" value="" onChange={onChange} mismatch="does not match" />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(
      <RetypeToConfirm id="c" label="Retype the id" subject="art_7412" value="art_74" onChange={onChange} mismatch="does not match" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("does not match");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    rerender(
      <RetypeToConfirm id="c" label="Retype the id" subject="art_7412" value="art_7412" onChange={onChange} mismatch="does not match" />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("labels the box so it can be found by its label, and reports every keystroke", () => {
    const onChange = vi.fn();
    render(<RetypeToConfirm id="c" label="Retype the id" subject="x" value="" onChange={onChange} mismatch="no" />);
    fireEvent.change(screen.getByLabelText("Retype the id"), { target: { value: "x" } });
    expect(onChange).toHaveBeenCalledWith("x");
  });
});
