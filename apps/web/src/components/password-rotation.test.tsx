// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { PasswordRotation } from "./password-rotation";

function renderRotation() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <PasswordRotation />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function fill(user: ReturnType<typeof userEvent.setup>, next: string, confirm: string) {
  renderRotation();
  await user.type(screen.getByLabelText("Current password"), "bootstrap-from-env");
  await user.type(screen.getByLabelText("New password"), next);
  await user.type(screen.getByLabelText("Confirm new password"), confirm);
  await user.click(screen.getByRole("button", { name: "Change password" }));
}

describe("PasswordRotation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says why the account is blocked, naming the variable", () => {
    // "Change your password" with no reason reads as bureaucracy. The operator needs to know the
    // current one is readable with `docker inspect`, or they will pick something equally casual.
    renderRotation();
    expect(screen.getByText(/SCHRODUMP_ADMIN_PASSWORD/)).toBeInTheDocument();
    expect(screen.getByText(/docker inspect/)).toBeInTheDocument();
  });

  it("refuses a mismatch without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await fill(userEvent.setup(), "a-long-enough-password", "a-different-password");
    expect(await screen.findByRole("alert")).toHaveTextContent("The two passwords do not match.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a short password without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await fill(userEvent.setup(), "short", "short");
    expect(await screen.findByRole("alert")).toHaveTextContent("Use at least 12 characters.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes other sessions when it rotates", async () => {
    // The bootstrap password sat in `docker inspect` output. Rotating it without cutting the
    // sessions it may already have opened leaves whoever read it still signed in.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await fill(userEvent.setup(), "a-long-enough-password", "a-long-enough-password");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/change-password",
      expect.objectContaining({
        body: JSON.stringify({
          currentPassword: "bootstrap-from-env",
          newPassword: "a-long-enough-password",
          revokeOtherSessions: true,
        }),
      }),
    );
  });

  it("keeps the operator here when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await fill(userEvent.setup(), "a-long-enough-password", "a-long-enough-password");
    expect(await screen.findByRole("alert")).toHaveTextContent("The password was not changed.");
  });
});
