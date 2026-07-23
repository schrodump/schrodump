// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Role } from "@/lib/domain";
import type { Artifact } from "@/lib/types";
import { RestoreButton } from "./restore-dialog";

const artifact: Artifact = {
  id: "artifact-1",
  jobId: "job-1",
  destinationId: "destination-1",
  state: "UNOBSERVED",
  bucketKey: "org/shop/2026-01-01.dump",
  manifestKey: "org/shop/2026-01-01.manifest.json",
  engine: "mysql",
  serverVersionNum: 80_036,
  sizeRawBytes: 4096,
  sizeCompressedBytes: 1024,
  checksumAlgorithm: "sha256",
  checksum: "deadbeef",
  compression: "zstd",
  keyIds: ["age1operational"],
  dependsOn: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function renderWith(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function renderButton(role: Role) {
  return renderWith(<RestoreButton artifact={artifact} role={role} />);
}

describe("RestoreButton", () => {
  it("does not render the trigger for a viewer", () => {
    renderButton("viewer");
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("renders the trigger for an operator", () => {
    renderButton("operator");
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });
});

describe("RestoreDialog", () => {
  async function openDialog() {
    const user = userEvent.setup();
    renderButton("operator");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    return user;
  }

  it("disables scopes the engine cannot restore, with a reason", async () => {
    await openDialog();
    // MySQL restores cluster/database/table — never schema or collection.
    expect(screen.getByLabelText("Database")).toBeEnabled();
    expect(screen.getByLabelText("Table")).toBeEnabled();
    expect(screen.getByLabelText("Schema")).toBeDisabled();
    expect(screen.getByLabelText("Collection")).toBeDisabled();
    expect(screen.getAllByText("Not supported for MySQL")).toHaveLength(2);
  });

  it("blocks restore over an existing database until the name is typed exactly", async () => {
    const user = await openDialog();
    await user.click(screen.getByLabelText("Database"));
    await user.type(screen.getByLabelText("Target database"), "shop");

    const submit = screen.getByRole("button", { name: "Start restore" });
    expect(submit).toBeEnabled();

    await user.click(screen.getByLabelText("Restore over an existing database (overwrites data)"));
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Type the database name to confirm"), "shopp");
    expect(submit).toBeDisabled();
    expect(screen.getByText("The name does not match the target database.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Type the database name to confirm"));
    await user.type(screen.getByLabelText("Type the database name to confirm"), "shop");
    expect(submit).toBeEnabled();
  });
});
