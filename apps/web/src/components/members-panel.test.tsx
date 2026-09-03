// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The last card that said "This data needs a server endpoint that is not available yet". Roles had
// been enforced since the first migration with no way to grant one: a product with three roles and
// one seat.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Member } from "@/lib/types";
import { MembersPanel } from "./members-panel";

const MEMBERS: Member[] = [
  {
    userId: "u-admin",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    mustChangePassword: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    userId: "u-new",
    email: "new@example.com",
    name: "New",
    role: "operator",
    mustChangePassword: true,
    createdAt: "2026-09-03T00:00:00.000Z",
  },
];

function renderPanel(responses: { ok: boolean; status: number; body?: unknown }[]) {
  const queue = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return Promise.resolve({
        ok: next?.ok ?? true,
        status: next?.status ?? 200,
        json: () => Promise.resolve(next?.body ?? {}),
      });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MembersPanel />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MembersPanel", () => {
  it("lists the organization's members with the role each one holds", async () => {
    renderPanel([{ ok: true, status: 200, body: MEMBERS }]);
    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(await screen.findByText("new@example.com")).toBeInTheDocument();
  });

  it("marks a member who has not yet replaced the password they were handed", async () => {
    // requireRole refuses EVERY action while that flag stands, for every role. Without saying so
    // the account looks broken rather than pending.
    renderPanel([{ ok: true, status: 200, body: MEMBERS }]);
    expect(await screen.findByText(/rotation|pending|change/i)).toBeInTheDocument();
  });

  it("tells a non-admin why it is empty instead of reading as 'no members'", async () => {
    renderPanel([{ ok: false, status: 403 }]);
    expect(await screen.findByText(/admin/i)).toBeInTheDocument();
  });

  it("shows the temporary password once, and says it will not be shown again", async () => {
    const user = userEvent.setup();
    renderPanel([
      { ok: true, status: 200, body: MEMBERS },
      {
        ok: true,
        status: 201,
        body: {
          temporaryPassword: "generated-secret-value",
          member: { ...MEMBERS[1], userId: "u-x", email: "x@example.com" },
        },
      },
      { ok: true, status: 200, body: MEMBERS },
    ]);
    await screen.findByText("admin@example.com");
    await user.type(screen.getByLabelText(/email/i), "x@example.com");
    await user.type(screen.getByLabelText(/name/i), "X");
    await user.click(screen.getByRole("button", { name: /add member/i }));

    expect(await screen.findByText("generated-secret-value")).toBeInTheDocument();
    expect(await screen.findByText(/once|not be shown again/i)).toBeInTheDocument();
  });
});
