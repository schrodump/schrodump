// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { THEME_STORAGE_KEY, ThemeToggle } from "./theme-toggle";

afterEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  delete document.documentElement.dataset.theme;
});

describe("ThemeToggle", () => {
  it("cycles system → light → dark → system, stamping <html> and remembering the choice", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ThemeToggle />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: /Theme: System/ });
    expect(document.documentElement.dataset.theme).toBeUndefined();

    await user.click(button);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    await user.click(button);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(button);
    // Back to the system: no stamp, nothing stored — the media query decides again.
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("starts from the stored choice", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(
      <I18nProvider>
        <ThemeToggle />
      </I18nProvider>,
    );
    expect(await screen.findByRole("button", { name: /Theme: Dark/ })).toBeInTheDocument();
  });
});
