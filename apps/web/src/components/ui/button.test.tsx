// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { Button } from "./button";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

describe("Button — nothing is disabled without its reason", () => {
  it("renders the reason beside a button it disables", () => {
    wrap(<Button disabledReason="pick exactly one database">Create target</Button>);
    const button = screen.getByRole("button", { name: /create target/i });
    expect(button).toBeDisabled();
    const note = screen.getByTestId("button-blocked-reason");
    expect(note).toHaveTextContent(/blocked — pick exactly one database/i);
    // The reason is announced with the control, not merely painted next to it.
    expect(button).toHaveAttribute("aria-describedby", note.id);
  });

  it("is enabled, with no note, when there is no reason", () => {
    wrap(<Button>Create target</Button>);
    expect(screen.getByRole("button")).toBeEnabled();
    expect(screen.queryByTestId("button-blocked-reason")).toBeNull();
  });

  it("still honours a bare `disabled` for the screens that predate the reason", () => {
    wrap(<Button disabled>Save</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.queryByTestId("button-blocked-reason")).toBeNull();
  });
});
