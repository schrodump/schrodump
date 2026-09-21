// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { I18nProvider } from "@/i18n/provider";
import type { DiscoverResult } from "@/lib/types";
import { TargetForm } from "./target-form";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const post = vi.mocked(api.post);

// What a two-database postgres server reports — the exact shape of the deployment where an unscoped
// target backed up the maintenance database while the 9.4 GB one sat beside it in this list.
const TWO_DATABASES: DiscoverResult = {
  ok: true,
  serverVersionNum: 170_011,
  failure: null,
  driverCode: null,
  databases: [
    { name: "acme_finance", sizeBytes: 9_896_000_000 },
    { name: "postgres", sizeBytes: 7_690_000 },
  ],
  isReplicaSet: false,
};

function answerDiscoveryWith(result: DiscoverResult) {
  post.mockImplementation((path: string) =>
    Promise.resolve(path === "/targets/discover" ? result : { id: "t1" }),
  );
}

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
const discoverButton = () => screen.getByRole("button", { name: "Discover databases" });
const createButton = () => screen.getByRole("button", { name: "Create target" });

async function fillConnection(user: ReturnType<typeof userEvent.setup>, engine = "postgres") {
  await user.selectOptions(screen.getByLabelText("Engine"), engine);
  await user.type(screen.getByLabelText("Name"), "Acme 1");
  await user.type(screen.getByLabelText("Host"), "acme_database");
  await user.type(screen.getByLabelText("Username"), "acme");
  await user.type(screen.getByLabelText("Password"), "s3cret");
}

function createdScope(): string[] {
  const call = post.mock.calls.find(([path]) => path === "/targets");
  expect(call).toBeDefined();
  return (call![1] as { scope: { databases: string[] } }).scope.databases;
}

beforeEach(() => {
  post.mockReset();
  answerDiscoveryWith(TWO_DATABASES);
});

describe("TargetForm connection URL", () => {
  it("fills the fields from a pasted URL and carries its database as the pending selection", async () => {
    const user = renderForm();
    await user.type(urlField(), "mysql://ana:s3cret@db.internal:3307/shop");
    await user.click(fillButton());

    expect(screen.getByLabelText("Engine")).toHaveValue("mysql");
    expect(screen.getByLabelText("Host")).toHaveValue("db.internal");
    expect(screen.getByLabelText("Port")).toHaveValue(3307);
    expect(screen.getByLabelText("Username")).toHaveValue("ana");
    expect(screen.getByText(/Currently: shop/)).toBeInTheDocument();
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

// The scope used to be a free-text field whose hint read "empty means all". For postgres that was
// false — empty meant the maintenance database — and on a real deployment it produced an 876-byte
// backup of nothing under a SUCCEEDED job. The scope is now chosen from what the server holds.
describe("TargetForm chooses the scope from what the server holds", () => {
  it("postgres: cannot be saved until a database has been chosen from a discovery", async () => {
    const user = renderForm();
    await fillConnection(user);

    expect(createButton()).toBeDisabled();
    expect(screen.getByText(/Discover the databases first/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("postgres: lists every database with its size, marks the maintenance one, and saves the pick", async () => {
    const user = renderForm();
    await fillConnection(user);
    await user.click(discoverButton());

    const finance = await screen.findByLabelText(/acme_finance/);
    expect(screen.getByText("9.2 GB")).toBeInTheDocument();
    expect(screen.getByLabelText(/^postgres/)).toHaveAccessibleName(/maintenance database/);
    expect(createButton()).toBeDisabled();

    await user.click(finance);
    expect(createButton()).toBeEnabled();
    await user.click(createButton());

    await waitFor(() => expect(createdScope()).toEqual(["acme_finance"]));
  });

  it("postgres: choosing is a click, never a default — nothing is pre-selected", async () => {
    // Refuse-don't-choose, in the form as on the server. Even when only one database besides the
    // maintenance one exists, the operator says which; a default here is what this replaces.
    const user = renderForm();
    await fillConnection(user);
    await user.click(discoverButton());
    await screen.findByLabelText(/acme_finance/);

    expect(createButton()).toBeDisabled();
  });

  it("postgres: a name carried from a URL that the server does not hold is dropped, not saved", async () => {
    const user = renderForm();
    await user.type(urlField(), "postgres://acme:s3cret@acme_database/acme_finnace");
    await user.click(fillButton());
    await user.type(screen.getByLabelText("Name"), "Acme 1");
    await user.click(discoverButton());
    await screen.findByLabelText(/acme_finance/);

    // The typo is gone and nothing is picked: Save stays refused instead of saving a name that
    // pg_dump would fail on at 02:00.
    expect(screen.queryByText(/acme_finnace/)).not.toBeInTheDocument();
    expect(createButton()).toBeDisabled();
  });

  it("mongodb replica set: the scope is locked to the whole instance and says why", async () => {
    answerDiscoveryWith({
      ...TWO_DATABASES,
      databases: [{ name: "zapyouv2", sizeBytes: 40_000_000_000 }],
      isReplicaSet: true,
    });
    const user = renderForm();
    await fillConnection(user, "mongodb");
    await user.click(discoverButton());

    expect(await screen.findByText(/replica set is dumped whole/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/zapyouv2/)).not.toBeInTheDocument();
    await user.click(createButton());
    await waitFor(() => expect(createdScope()).toEqual([]));
  });

  it("mysql: saving needs no discovery, and nothing selected means every database", async () => {
    const user = renderForm();
    await fillConnection(user, "mysql");

    expect(createButton()).toBeEnabled();
    await user.click(createButton());
    await waitFor(() => expect(createdScope()).toEqual([]));
  });

  it("a failed discovery says why and offers nothing to pick", async () => {
    answerDiscoveryWith({
      ok: false,
      serverVersionNum: null,
      failure: "AUTH_FAILED",
      driverCode: null,
      databases: [],
      isReplicaSet: null,
    });
    const user = renderForm();
    await fillConnection(user);
    await user.click(discoverButton());

    expect(await screen.findByText(/refused those credentials/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(createButton()).toBeDisabled();
  });
});

// The list a discovery returns belongs to the connection it ran against. Editing the host after
// a pick would otherwise save a database name against a server nobody asked.
describe("TargetForm keeps a discovery honest about where it came from", () => {
  it("marks the list stale when the connection changes, clears the pick, and blocks Save until discover runs again", async () => {
    const user = renderForm();
    await fillConnection(user);
    await user.click(discoverButton());
    await user.click(await screen.findByLabelText(/acme_finance/));
    expect(createButton()).toBeEnabled();

    await user.type(screen.getByLabelText("Host"), "-replica");

    expect(screen.getByText("The connection changed since discover ran.")).toBeInTheDocument();
    expect(screen.getByText(/The list came from postgres acme_database:5432 as acme/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/acme_finance/)).toBeNull();
    expect(createButton()).toBeDisabled();
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/run discover and pick a scope/i);
  });

  it("says why Save is blocked, in the order the operator would fix things", async () => {
    const user = renderForm();
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/name the target before saving/i);
    await user.type(screen.getByLabelText("Name"), "Acme 1");
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/a host is required/i);
    await user.type(screen.getByLabelText("Host"), "db");
    await user.type(screen.getByLabelText("Username"), "acme");
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/a password is required/i);
  });

  it("follows the engine's default port only while the port is still a default", async () => {
    const user = renderForm();
    expect(screen.getByLabelText("Port")).toHaveValue(5432);
    await user.selectOptions(screen.getByLabelText("Engine"), "mongodb");
    expect(screen.getByLabelText("Port")).toHaveValue(27017);
    await user.clear(screen.getByLabelText("Port"));
    await user.type(screen.getByLabelText("Port"), "27018");
    await user.selectOptions(screen.getByLabelText("Engine"), "mysql");
    expect(screen.getByLabelText("Port")).toHaveValue(27018);
  });
});

// "Require TLS" was a checkbox that meant "encrypt, verify nothing" to pg_dump and "verify against
// Node's bundled CAs" to the probe, and said neither. The form now says which mode it is in, takes
// the CA that makes it verified, and connects with it — at discovery and in what it saves.
describe("TargetForm and TLS", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIBsjCCAVigAwIBAgIUQ\n-----END CERTIFICATE-----\n";
  const caField = () => screen.getByLabelText("CA certificate (PEM, optional)");
  const tlsMode = () => document.querySelector("[data-tls-mode]");

  function bodyOf(path: string): Record<string, unknown> {
    const call = post.mock.calls.find(([p]) => p === path);
    expect(call).toBeDefined();
    return call![1] as Record<string, unknown>;
  }

  it("says what each mode means, and that TLS without a CA verifies nothing", async () => {
    const user = renderForm();
    expect(tlsMode()).toHaveAttribute("data-tls-mode", "unverified");
    expect(tlsMode()).toHaveTextContent(/certificate is not verified/);

    await user.click(caField());
    await user.paste(PEM);
    expect(tlsMode()).toHaveAttribute("data-tls-mode", "ca");
    expect(tlsMode()).toHaveTextContent(/checked against the CA below/);

    await user.click(screen.getByLabelText("Require TLS"));
    expect(tlsMode()).toHaveAttribute("data-tls-mode", "off");
    // No CA field while TLS is off: the server refuses one sent with TLS off.
    expect(screen.queryByLabelText("CA certificate (PEM, optional)")).toBeNull();
  });

  it("tells a MongoDB operator that TLS without a CA verifies against the system store", async () => {
    const user = renderForm();
    await user.selectOptions(screen.getByLabelText("Engine"), "mongodb");
    expect(tlsMode()).toHaveAttribute("data-tls-mode", "system");
    expect(tlsMode()).toHaveTextContent(/system trust store/);
  });

  it("discovers over the connection the backup will use, CA included, and saves it", async () => {
    const user = renderForm();
    await fillConnection(user);
    await user.click(caField());
    await user.paste(PEM);
    await user.click(discoverButton());
    // Picked by the fixture's own name, whatever it is called.
    const [firstDatabase] = TWO_DATABASES.databases;
    await user.click(await screen.findByLabelText(new RegExp(firstDatabase!.name)));
    await user.click(createButton());

    await waitFor(() => expect(post.mock.calls.some(([p]) => p === "/targets")).toBe(true));
    expect(bodyOf("/targets/discover")).toMatchObject({ tls: true, tlsCaCert: PEM });
    expect(bodyOf("/targets")).toMatchObject({ tls: true, tlsCaCert: PEM });
    // And the verdict says how that connection was secured.
    expect(screen.getByText(/verified against the CA certificate · host name checked/)).toBeInTheDocument();
  });

  it("never sends a CA with TLS off, even one pasted before TLS was switched off", async () => {
    const user = renderForm();
    await fillConnection(user, "mysql");
    await user.click(caField());
    await user.paste(PEM);
    await user.click(screen.getByLabelText("Require TLS"));
    await user.click(createButton());
    await waitFor(() => expect(post.mock.calls.some(([p]) => p === "/targets")).toBe(true));
    expect(bodyOf("/targets")).toMatchObject({ tls: false, tlsCaCert: null });
  });

  // The field is stored in clear and shown to every viewer; the likeliest wrong paste is the key.
  it("blocks Save on a pasted private key, and says so", async () => {
    const user = renderForm();
    await fillConnection(user, "mysql");
    await user.click(caField());
    await user.paste("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n");
    expect(createButton()).toBeDisabled();
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/that is a private key/i);
    expect(post).not.toHaveBeenCalled();
  });

  it("warns that a mysql target without a CA cannot be staged", async () => {
    const user = renderForm();
    await user.selectOptions(screen.getByLabelText("Engine"), "mysql");
    expect(screen.getByText(/mydumper cannot require TLS without verifying it/)).toBeInTheDocument();
    await user.click(caField());
    await user.paste(PEM);
    expect(screen.queryByText(/mydumper cannot require TLS without verifying it/)).toBeNull();
  });

  it("a pasted URL asking for verification turns TLS on and asks for the CA it cannot carry", async () => {
    const user = renderForm();
    await user.type(urlField(), "postgres://ana:s3cret@db.internal/shop?sslmode=verify-full");
    await user.click(fillButton());
    expect(screen.getByLabelText("Require TLS")).toBeChecked();
    expect(screen.getByText(/A URL can name a CA file but not carry it/)).toBeInTheDocument();

    await user.click(caField());
    await user.paste(PEM);
    expect(screen.queryByText(/A URL can name a CA file but not carry it/)).toBeNull();
  });
});

