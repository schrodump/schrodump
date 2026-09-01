// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { EncryptionKey } from "@/lib/types";
import { EncryptionKeysPanel } from "./encryption-keys";

const ESCROW: EncryptionKey = {
  keyId: "esc-1",
  type: "escrow",
  state: "active",
  publicRecipient: "age1escrowrecipient",
  serverCanDecrypt: false,
  createdAt: "2026-09-01T00:00:00.000Z",
};

function renderPanel(opts: { keys?: EncryptionKey[]; canEdit?: boolean; post?: unknown } = {}) {
  const fetchMock = vi.fn((url: string, init?: { method?: string }) => {
    if (init?.method === "POST") return Promise.resolve(opts.post ?? { ok: false, status: 500 });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(opts.keys ?? []),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <EncryptionKeysPanel canEdit={opts.canEdit ?? true} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe("EncryptionKeysPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says backups cannot run when no keys exist", async () => {
    renderPanel({ keys: [] });
    expect(await screen.findByText(/Backups cannot run until these exist/)).toBeInTheDocument();
  });

  it("hides the generate form from a non-admin but still shows the state", async () => {
    renderPanel({ keys: [], canEdit: false });
    expect(await screen.findByText(/Backups cannot run/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate both keys" })).toBeNull();
  });

  it("shows the escrow key as offline, never as something the server holds", async () => {
    renderPanel({ keys: [ESCROW] });
    expect(await screen.findByText("Identity kept offline")).toBeInTheDocument();
    expect(screen.queryByText("Server holds the identity")).toBeNull();
  });

  // The identity is shown once and stored nowhere. The acknowledgement gate is the only thing
  // standing between the operator and losing it by navigating away.
  it("reveals the escrow identity and gates dismissal on an explicit acknowledgement", async () => {
    const user = userEvent.setup();
    renderPanel({
      keys: [],
      post: {
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            operationalKeyId: "op-1",
            escrowKeyId: "esc-1",
            escrowIdentity: "AGE-SECRET-KEY-1REVEALEDONCE",
            escrowIdentityWarning: "Save this now.",
          }),
      },
    });
    await user.click(await screen.findByRole("button", { name: "Generate both keys" }));

    expect(await screen.findByText("AGE-SECRET-KEY-1REVEALEDONCE")).toBeInTheDocument();
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();

    await user.click(screen.getByLabelText("I have saved it somewhere safe"));
    expect(done).toBeEnabled();
  });

  // The operator supplied their own recipient, so there is no identity to reveal — and inventing a
  // "save this" step would misrepresent what just happened.
  it("reveals nothing when the operator brought their own recipient", async () => {
    const user = userEvent.setup();
    const fetchMock = renderPanel({
      keys: [],
      post: {
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            operationalKeyId: "op-1",
            escrowKeyId: "esc-1",
            escrowIdentity: null,
            escrowIdentityWarning: null,
          }),
      },
    });
    await user.click(await screen.findByRole("button", { name: "Generate both keys" }));
    await user.click(screen.getByLabelText(/I have my own escrow key/));
    await user.type(screen.getByLabelText(/Escrow public recipient/), "age1mine");
    await user.click(screen.getByRole("button", { name: "Generate both keys" }));

    expect(screen.queryByText(/AGE-SECRET-KEY/)).toBeNull();
    const posted = fetchMock.mock.calls.find(([, init]) => (init as { method?: string })?.method === "POST");
    expect(posted?.[0]).toBe("/backend/encryption-keys");
  });
});
