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
  targetName: "shop-prod",
  policyName: "nightly",
  restoreInto: { host: "db.internal", port: 5432, database: "shop", schemas: [], collections: [] },
  state: "UNOBSERVED",
  verifiedLevel: null,
  verifiedDegraded: false,
  bucketKey: "org/shop/2026-01-01.dump",
  manifestKey: "org/shop/2026-01-01.manifest.json",
  engine: "postgres",
  executionMode: "STREAM",
  sourceHasOplog: null,
  dumpIsMultiDatabase: null,
  serverVersionNum: 160_002,
  sizeRawBytes: 4096,
  sizeCompressedBytes: 1024,
  checksumAlgorithm: "sha256",
  checksum: "deadbeef",
  compression: "zstd",
  keyIds: ["age1operational"],
  dependsOn: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
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
    // Postgres restores cluster/database/schema/table, never collection: it has none.
    expect(screen.getByLabelText("Database")).toBeEnabled();
    expect(screen.getByLabelText("Collection")).toBeDisabled();
    expect(screen.getAllByText("Not supported for PostgreSQL")).toHaveLength(1);
  });

  // The server restores into the producing policy's target and nowhere else. The dialog used to name
  // the artifact and collect a "target database" the request never carried, so an operator could
  // believe they were restoring into a scratch copy while the worker wrote over production.
  it("says where the restore writes — the target, its host and port, and the database", async () => {
    await openDialog();
    const into = screen.getByTestId("restore-into");
    expect(into).toHaveTextContent("shop-prod");
    expect(into).toHaveTextContent("db.internal:5432");
    expect(into).toHaveTextContent("database shop");
    expect(screen.queryByLabelText("Target database")).toBeNull();
  });

  // The widening that was live: a SCHEMA restore whose target named no schema ran
  // pg_restore --clean over the whole database. Nothing in the interface can name one, so the
  // option says so instead of being offered.
  it("withholds SCHEMA and TABLE when nothing names the schema or the table, with the reason", async () => {
    await openDialog();
    expect(screen.getByLabelText("Schema")).toBeDisabled();
    expect(screen.getByLabelText("Schema").closest("div")).toHaveTextContent(/rewrite the whole database/i);
    expect(screen.getByLabelText("Table")).toBeDisabled();
  });

  it("offers SCHEMA when the target does name a schema", async () => {
    const user = userEvent.setup();
    renderWith(
      <RestoreButton
        artifact={{ ...artifact, restoreInto: { ...artifact.restoreInto!, schemas: ["billing"] } }}
        role="operator"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByLabelText("Schema")).toBeEnabled();
  });

  it("refuses to start when the target the artifact was written for is gone", async () => {
    const user = userEvent.setup();
    renderWith(<RestoreButton artifact={{ ...artifact, restoreInto: null }} role="operator" />);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/nowhere to restore into/i);
    expect(screen.getByRole("button", { name: "Start restore" })).toBeDisabled();
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/no longer exists/i);
  });

  it("blocks restore over an existing database until its real name is retyped exactly", async () => {
    const user = await openDialog();
    await user.click(screen.getByLabelText("Database"));

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

  it("blocks a full-cluster overwrite until every database on the destination is acknowledged", async () => {
    const user = await openDialog();
    // FULL_CLUSTER is the default scope for postgres — there is no single database name to retype.
    const submit = screen.getByRole("button", { name: "Start restore" });
    expect(submit).toBeEnabled();
    expect(screen.queryByTestId("button-blocked-reason")).toBeNull();

    await user.click(screen.getByLabelText("Restore over an existing database (overwrites data)"));
    expect(submit).toBeDisabled();
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(
      /acknowledge the overwrite to unlock/i,
    );
    expect(screen.queryByLabelText("Type the database name to confirm")).toBeNull();

    await user.click(
      screen.getByLabelText("I understand this overwrites every database on the destination"),
    );
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

// The second lock on the server's newest refusal. A mysqldump script replays its own USE statements
// and mysql offers no flag to confine it, so a DATABASE restore of a script carrying several
// databases rewrites all of them — measured, with the client exiting 0. The dialog must not offer
// a target the server is certain to refuse, and must not make it look like an engine limitation:
// the same engine restores one database perfectly well when the script carries only one.
describe("RestoreDialog — a mysql script that carries more than one database", () => {
  const mysql = (dumpIsMultiDatabase: boolean | null): Artifact => ({
    ...artifact,
    engine: "mysql",
    dumpIsMultiDatabase,
  });

  async function openDialogFor(subject: Artifact) {
    const user = userEvent.setup();
    renderWith(<RestoreButton artifact={subject} role="operator" />);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    return user;
  }

  it("offers a DATABASE restore when the artifact is recorded single-database", async () => {
    await openDialogFor(mysql(false));
    expect(screen.getByLabelText("Database")).toBeEnabled();
  });

  it("withholds a DATABASE restore for a multi-database artifact", async () => {
    await openDialogFor(mysql(true));
    expect(screen.getByLabelText("Database")).toBeDisabled();
  });

  it("withholds it when the fact was never recorded, exactly as the server does", async () => {
    await openDialogFor(mysql(null));
    expect(screen.getByLabelText("Database")).toBeDisabled();
  });

  it("gives the artifact's reason on that row, not the engine's", async () => {
    // SCHEMA/TABLE/COLLECTION genuinely are engine limitations here and keep saying so. DATABASE is
    // the one this artifact withholds, and it has to say why itself — an operator told "not
    // supported for MySQL" would conclude the engine cannot do it and stop looking.
    await openDialogFor(mysql(true));
    const databaseRow = screen.getByLabelText("Database").closest("div");
    expect(databaseRow).toHaveTextContent(/more than one database/i);
    expect(databaseRow).not.toHaveTextContent(/not supported/i);
  });

  it("still offers a full-cluster restore, which is what the script actually does", async () => {
    await openDialogFor(mysql(true));
    expect(screen.getByLabelText("Full cluster")).toBeEnabled();
  });
});
