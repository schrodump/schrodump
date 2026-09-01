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

function renderPanel(
  opts: { keys?: EncryptionKey[]; canEdit?: boolean; post?: unknown; rotate?: unknown } = {},
) {
  const fetchMock = vi.fn((url: string, init?: { method?: string }) => {
    if (init?.method === "POST") {
      if (url === "/backend/encryption-keys/rotate") {
        return Promise.resolve(opts.rotate ?? { ok: false, status: 500 });
      }
      return Promise.resolve(opts.post ?? { ok: false, status: 500 });
    }
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

describe("EncryptionKeysPanel — rotation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const OPERATIONAL: EncryptionKey = {
    keyId: "op-1",
    type: "operational",
    state: "active",
    publicRecipient: "age1operational",
    serverCanDecrypt: true,
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  const rotated = (over: Record<string, unknown> = {}) => ({
    ok: true,
    status: 201,
    json: () =>
      Promise.resolve({
        type: "operational",
        retiredKeyId: "op-1",
        newKeyId: "op-2",
        escrowIdentity: null,
        escrowIdentityWarning: null,
        consequences: {
          existingArtifactsUnchanged: true,
          predecessorReadableByServer: true,
          operatorMustRetain: null,
          doesNotRemediateExposure: "Rotation seals FUTURE backups to the new key.",
        },
        ...over,
      }),
  });

  it("hides rotation from a non-admin", async () => {
    renderPanel({ keys: [OPERATIONAL], canEdit: false });
    expect(await screen.findByText("Operational")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
  });

  // The dangerous belief is that rotating a leaked key closes the leak. The confirmation exists so
  // that sentence has to be read, and the button stays dead until it is acknowledged.
  it("refuses to rotate until the operator acknowledges what rotation does not do", async () => {
    const user = userEvent.setup();
    const fetchMock = renderPanel({ keys: [OPERATIONAL], rotate: rotated() });

    await user.click(await screen.findByRole("button", { name: "Rotate" }));
    expect(screen.getByText(/does not undo exposure/i)).toBeInTheDocument();

    const confirm = screen.getByRole("button", { name: "Rotate the key" });
    expect(confirm).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/backend/encryption-keys/rotate"),
    ).toBe(false);

    await user.click(screen.getByLabelText(/protects future backups only/i));
    expect(confirm).toBeEnabled();
  });

  it("sends the operational rotation without an escrow block", async () => {
    const user = userEvent.setup();
    const fetchMock = renderPanel({ keys: [OPERATIONAL], rotate: rotated() });

    await user.click(await screen.findByRole("button", { name: "Rotate" }));
    await user.click(screen.getByLabelText(/protects future backups only/i));
    await user.click(screen.getByRole("button", { name: "Rotate the key" }));

    const call = fetchMock.mock.calls.find(([url]) => url === "/backend/encryption-keys/rotate");
    expect(call).toBeDefined();
    // The server schema is .strict(): an escrow block on an operational rotation is a 400.
    expect(JSON.parse((call?.[1] as { body: string }).body)).toEqual({ type: "operational" });
  });

  it("carries the server's own retention sentence after rotating escrow", async () => {
    const user = userEvent.setup();
    renderPanel({
      keys: [ESCROW],
      rotate: rotated({
        type: "escrow",
        escrowIdentity: null,
        consequences: {
          existingArtifactsUnchanged: true,
          predecessorReadableByServer: false,
          operatorMustRetain: "Keep the OUTGOING escrow identity.",
          doesNotRemediateExposure: "Rotation seals FUTURE backups to the new key.",
        },
      }),
    });

    await user.click(await screen.findByRole("button", { name: "Rotate" }));
    await user.click(screen.getByLabelText(/protects future backups only/i));
    await user.click(screen.getByRole("button", { name: "Rotate the key" }));

    // The API's sentence, not a local paraphrase — what must be retained is a property of the
    // rotation and must not drift from what the server decided.
    expect(await screen.findByText("Keep the OUTGOING escrow identity.")).toBeInTheDocument();
  });

  it("reveals a generated escrow identity once, gated the same way as provisioning", async () => {
    const user = userEvent.setup();
    renderPanel({
      keys: [ESCROW],
      rotate: rotated({
        type: "escrow",
        escrowIdentity: "AGE-SECRET-KEY-1ROTATEDESCROW",
        escrowIdentityWarning: "Save this now.",
        consequences: {
          existingArtifactsUnchanged: true,
          predecessorReadableByServer: false,
          operatorMustRetain: "Keep the OUTGOING escrow identity.",
          doesNotRemediateExposure: "Rotation seals FUTURE backups to the new key.",
        },
      }),
    });

    await user.click(await screen.findByRole("button", { name: "Rotate" }));
    await user.click(screen.getByLabelText(/protects future backups only/i));
    await user.click(screen.getByRole("button", { name: "Rotate the key" }));

    expect(await screen.findByText("AGE-SECRET-KEY-1ROTATEDESCROW")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  });

  // A retired key is what opens everything written before the rotation. Showing it without saying
  // so invites an operator to read the extra row as clutter.
  it("labels a retired key and offers no rotate button for it", async () => {
    renderPanel({
      keys: [
        { ...OPERATIONAL, keyId: "op-0", state: "retired" },
        { ...OPERATIONAL, keyId: "op-1", state: "active" },
      ],
    });

    expect(await screen.findByText(/Still opens artifacts written before/)).toBeInTheDocument();
    // One button, for the active key only.
    expect(screen.getAllByRole("button", { name: "Rotate" })).toHaveLength(1);
  });
});
