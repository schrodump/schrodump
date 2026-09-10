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

describe("ChannelRow delete", () => {
  it("offers to disable instead when the channel is recording failures", async () => {
    const user = userEvent.setup();
    renderWith(<ChannelRow channel={{ ...WEBHOOK, lastFailure: "webhook delivery failed with status 500" }} canEdit />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/throws away the only evidence/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable instead" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete channel" })).toBeInTheDocument();
  });

  it("asks plainly when nothing is failing", async () => {
    const user = userEvent.setup();
    renderWith(<ChannelRow channel={WEBHOOK} canEdit />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this channel? Nothing will be sent through it again.")).toBeInTheDocument();
    expect(screen.queryByText(/throws away the only evidence/)).toBeNull();
  });
});

describe("ChannelForm", () => {
  it("blocks Add channel with the reason until the kind's fields are filled", async () => {
    const user = userEvent.setup();
    renderWith(<ChannelForm />);
    expect(screen.getByRole("button", { name: "Add channel" })).toBeDisabled();
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/a webhook URL is required/i);
    await user.type(screen.getByLabelText("Webhook URL"), "https://hooks.example/y");
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/a signing secret is required/i);
  });

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

// The bug this file did not catch. The server has always required 16 characters and has always
// answered a shorter one with a 400 — but the form asked for "a signing secret", accepted any
// non-empty string, and forwarded it. What came back named no field, so the operator read the
// refusal against the only other thing on screen: the URL they had just pasted.
describe("ChannelForm — the rules the server enforces are the rules the form states", () => {
  it("blocks a signing secret below the length the server will accept", async () => {
    const user = userEvent.setup();
    renderWith(<ChannelForm />);
    await user.type(screen.getByLabelText("Webhook URL"), "https://hooks.example/y");
    await user.type(screen.getByLabelText("Signing secret"), "short-secret");
    expect(screen.getByRole("button", { name: "Add channel" })).toBeDisabled();
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/16 characters/i);
  });

  it("says how long the secret has to be before it is typed, not after it is refused", () => {
    renderWith(<ChannelForm />);
    expect(screen.getByText(/16 characters/i)).toBeInTheDocument();
  });

  it("never sends a port of 0 when the port field is emptied", async () => {
    // The field shows 587 as a PLACEHOLDER, not a value. Typing and deleting leaves "", and
    // Number("") is 0, which the server refuses as not positive — another opaque 400 for something
    // the operator never chose.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve(WEBHOOK) });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderWith(<ChannelForm />);
    await user.selectOptions(screen.getByLabelText("Kind"), "SMTP");
    await user.type(screen.getByLabelText("SMTP host"), "smtp.example");
    await user.type(screen.getByLabelText("Port"), "587");
    await user.clear(screen.getByLabelText("Port"));
    await user.type(screen.getByLabelText("Username"), "schrodump");
    await user.type(screen.getByLabelText("Password"), "s3cret");
    await user.type(screen.getByLabelText("From address"), "schrodump@example.com");
    await user.type(screen.getByLabelText(/Recipients/), "ops@example.com");

    expect(screen.getByRole("button", { name: "Add channel" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the field the server refused, for the rules the form does not know", async () => {
    // The form guards what it can state up front. Everything else — a URL the server's parser
    // rejects for a reason this form has no opinion about — arrives as a refusal that has to name
    // its own field, or the operator is back to guessing.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "invalid channel", field: "url", detail: "Invalid URL" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderWith(<ChannelForm />);
    await user.type(screen.getByLabelText("Webhook URL"), "https://hooks.example/y");
    await user.type(screen.getByLabelText("Signing secret"), "a-signing-secret-value");
    await user.click(screen.getByRole("button", { name: "Add channel" }));

    expect(await screen.findByText(/url/)).toBeInTheDocument();
    expect(screen.getByText(/Invalid URL/)).toBeInTheDocument();
  });
});
