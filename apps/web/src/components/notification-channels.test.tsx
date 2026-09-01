// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { NotificationChannel } from "@/lib/types";
import { ChannelForm, ChannelRow } from "./notification-channels";

const WEBHOOK: NotificationChannel = {
  id: "c1",
  kind: "WEBHOOK",
  url: "https://hooks.example/x",
  smtpHost: null,
  smtpPort: null,
  smtpUsername: null,
  fromAddress: null,
  toAddresses: [],
  enabled: true,
  lastFailureAt: null,
  lastFailure: null,
};

function renderWith(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ChannelRow", () => {
  it("surfaces a channel's last delivery failure", () => {
    // The whole reason that column exists. A channel that silently stopped delivering looks
    // identical to a healthy one unless the interface says otherwise.
    renderWith(
      <ChannelRow
        channel={{ ...WEBHOOK, lastFailure: "webhook delivery failed with status 500" }}
        canEdit
      />,
    );
    expect(screen.getByText(/status 500/)).toBeInTheDocument();
  });

  it("shows no controls to a viewer", () => {
    // The server enforces operator+ independently; this is the second lock, and it fails closed.
    renderWith(<ChannelRow channel={WEBHOOK} canEdit={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers disable rather than only delete", () => {
    // Deleting a channel that is recording failures throws away the only evidence it was failing,
    // so the reversible operation has to be present and reachable.
    renderWith(<ChannelRow channel={WEBHOOK} canEdit />);
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });
});

describe("ChannelForm", () => {
  it("never submits a channel that is half webhook and half email", async () => {
    // The server's schema is a strict discriminated union, so a stray field from the other kind is
    // a 400 — but the point is that such a channel should not be expressible here either.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(WEBHOOK),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderWith(<ChannelForm />);
    await user.type(screen.getByLabelText("Webhook URL"), "https://hooks.example/y");
    await user.type(screen.getByLabelText("Signing secret"), "a-signing-secret-value");
    await user.click(screen.getByRole("button", { name: "Add channel" }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["kind", "url", "secret"]);
    expect(body.kind).toBe("WEBHOOK");
  });

  it("splits recipients per line and drops the blanks", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(WEBHOOK),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderWith(<ChannelForm />);
    await user.selectOptions(screen.getByLabelText("Kind"), "SMTP");
    await user.type(screen.getByLabelText("SMTP host"), "smtp.example");
    await user.type(screen.getByLabelText("Port"), "587");
    await user.type(screen.getByLabelText("Username"), "schrodump");
    await user.type(screen.getByLabelText("Password"), "s3cret");
    await user.type(screen.getByLabelText("From address"), "schrodump@example.com");
    await user.type(
      screen.getByLabelText(/Recipients/),
      "ops@example.com\n\n  oncall@example.com  ",
    );
    await user.click(screen.getByRole("button", { name: "Add channel" }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.toAddresses).toEqual(["ops@example.com", "oncall@example.com"]);
    expect(body.smtpPort).toBe(587);
    expect(Object.keys(body)).not.toContain("url");
  });
});
