// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { TargetForm } from "./target-form";

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <TargetForm onDone={() => undefined} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const urlField = () => screen.getByLabelText("Connection URL");
const fillButton = () => screen.getByRole("button", { name: "Fill the fields" });

describe("TargetForm connection URL", () => {
  it("fills the fields from a pasted URL", async () => {
    const user = renderForm();
    await user.type(urlField(), "mysql://ana:s3cret@db.internal:3307/shop");
    await user.click(fillButton());

    expect(screen.getByLabelText("Engine")).toHaveValue("mysql");
    expect(screen.getByLabelText("Host")).toHaveValue("db.internal");
    expect(screen.getByLabelText("Port")).toHaveValue(3307);
    expect(screen.getByLabelText("Username")).toHaveValue("ana");
    expect(screen.getByLabelText(/Databases to back up/)).toHaveValue("shop");
  });

  it("clears the URL once it has been read, so the password is not held twice", async () => {
    const user = renderForm();
    await user.type(urlField(), "postgres://ana:s3cret@db.internal/shop");
    await user.click(fillButton());

    expect(urlField()).toHaveValue("");
  });

  it("leaves TLS on when the URL says nothing about it", async () => {
    const user = renderForm();
    await user.type(urlField(), "postgres://ana:s3cret@db.internal/shop");
    await user.click(fillButton());

    expect(screen.getByLabelText("Require TLS")).toBeChecked();
  });

  it("turns TLS off only when the URL says so", async () => {
    const user = renderForm();
    await user.type(urlField(), "postgres://ana:s3cret@db.internal/shop?sslmode=disable");
    await user.click(fillButton());

    expect(screen.getByLabelText("Require TLS")).not.toBeChecked();
  });

  it("reports why an SRV URI is refused and touches nothing", async () => {
    const user = renderForm();
    await user.type(urlField(), "mongodb+srv://ana:s3cret@cluster.example.net/shop");
    await user.click(fillButton());

    expect(screen.getByText(/mongodb\+srv cannot be used here/)).toBeInTheDocument();
    // The host field stays empty: a failed parse must not leave the form half-filled.
    expect(screen.getByLabelText("Host")).toHaveValue("");
    expect(urlField()).not.toHaveValue("");
  });
});
