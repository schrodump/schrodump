// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  engine: "postgres",
  executionMode: "STREAM",
  serverVersionNum: 160_002,
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

  it.each(["postgres", "mysql", "mariadb", "mongodb"] as const)(
    "enables the trigger for a STREAM %s artifact — restore works for all four engines",
    (engine) => {
      renderWith(<RestoreButton artifact={{ ...artifact, engine }} role="operator" />);
      expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
    },
  );

  // STAGED used to be disabled here because the server refused it. The server now unpacks the
  // directory dump and restores from it, so leaving the button disabled would hide a restore that
  // works — and the gate being execution-mode-based means every engine moves together.
  it.each(["postgres", "mysql", "mariadb", "mongodb"] as const)(
    "enables the trigger for a STAGED %s artifact, which the server can now restore",
    (engine) => {
      renderWith(
        <RestoreButton
          artifact={{ ...artifact, engine, executionMode: "STAGED" }}
          role="operator"
        />,
      );
      expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
    },
  );
});

describe("RestoreDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openDialog() {
    const user = userEvent.setup();
    renderButton("operator");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    return user;
  }

  it("disables scopes the engine cannot restore, with a reason", async () => {
    await openDialog();
    // PostgreSQL restores cluster/database/schema. Never collection — it has none — and no longer
    // table: no adapter emits a table-scoping flag, so a TABLE restore ran --clean over the WHOLE
    // dump and dropped every table in the database to write one. Withdrawn server-side; offering
    // it here would put a button in front of a guaranteed rejection.
    expect(screen.getByLabelText("Database")).toBeEnabled();
    expect(screen.getByLabelText("Schema")).toBeEnabled();
    expect(screen.getByLabelText("Table")).toBeDisabled();
    expect(screen.getByLabelText("Collection")).toBeDisabled();
    expect(screen.getAllByText("Not supported for PostgreSQL")).toHaveLength(2);
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

  it("submits the restore and shows the enqueued confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ jobId: "job-2" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = await openDialog();
    await user.click(screen.getByLabelText("Database"));
    await user.type(screen.getByLabelText("Target database"), "shop");

    await user.click(screen.getByRole("button", { name: "Start restore" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/backend/artifacts/artifact-1/restore",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ target: "DATABASE", confirmExistingDatabase: false }),
      }),
    );

    expect(await screen.findByText("Restore enqueued")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start restore" })).toBeDisabled();
  });
});
