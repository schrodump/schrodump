// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { CredentialField } from "./credential-field";

function renderField(configured: boolean) {
  const onChange = vi.fn();
  render(
    <I18nProvider>
      <CredentialField id="secret" label="Password" configured={configured} value="" onChange={onChange} />
    </I18nProvider>,
  );
  return { onChange };
}

describe("CredentialField", () => {
  it("shows 'Configured' and no input for an already-set credential — never the server value", () => {
    renderField(true);
    expect(screen.getByText("Configured")).toBeInTheDocument();
    // No credential input is rendered, so no server value can ever appear in one.
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("reveals an EMPTY input only after Replace is clicked", async () => {
    const user = userEvent.setup();
    renderField(true);
    await user.click(screen.getByRole("button", { name: "Replace" }));
    const input = screen.getByLabelText("Password");
    expect(input).toHaveValue(""); // the input is created empty — never seeded from the server
  });

  it("starts with an empty input when nothing is configured yet", () => {
    renderField(false);
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
});
