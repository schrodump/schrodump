// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { AccountMenu } from "./account-menu";
import { THEME_STORAGE_KEY } from "./theme-toggle";

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

function renderMenu(onSignOut = vi.fn()) {
  render(
    <I18nProvider>
      <AccountMenu email="ops@example.test" onSignOut={onSignOut} />
    </I18nProvider>,
  );
  return { user: userEvent.setup(), onSignOut };
}

describe("AccountMenu", () => {
  it("shows only the current language's flag and code until opened", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Account and preferences" });
    expect(trigger).toHaveTextContent("EN");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lists the languages in their own names, marks the current one, and switches on a pick", async () => {
    const { user } = renderMenu();
    await user.click(screen.getByRole("button", { name: "Account and preferences" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /English/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /Português \(Brasil\)/ })).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByRole("menuitemradio", { name: /Português \(Brasil\)/ }));
    // The whole provider switched: the trigger now reads in Portuguese, and the menu closed.
    expect(screen.getByRole("button", { name: "Conta e preferências" })).toHaveTextContent("PT-BR");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stamps the theme on <html>, remembers it, and says what the browser reports for system", async () => {
    const { user } = renderMenu();
    await user.click(screen.getByRole("button", { name: "Account and preferences" }));
    expect(screen.getByRole("menuitemradio", { name: /System/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /System/ })).toHaveTextContent(/now light/);

    await user.click(screen.getByRole("menuitemradio", { name: /Dark/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Account and preferences" }));
    expect(screen.getByRole("menuitemradio", { name: /Dark/ })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: /System/ }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("closes on Escape and on a click outside", async () => {
    const { user } = renderMenu();
    const trigger = screen.getByRole("button", { name: "Account and preferences" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("signs out from the menu", async () => {
    const { user, onSignOut } = renderMenu();
    await user.click(screen.getByRole("button", { name: "Account and preferences" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
