// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The server records three answers and the interface has to keep them three. Telling an operator
// their bucket "failed" a check nobody ran is worse than saying nothing.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { LastCheck } from "./last-check";

const KEYS = {
  never: "destinations.canary.never",
  lastOk: "destinations.canary.lastOk",
  lastFailed: "destinations.canary.lastFailed",
} as const;

function renderCheck(ok: boolean | null, at: string | null) {
  return render(
    <I18nProvider>
      <LastCheck ok={ok} at={at} keys={KEYS} />
    </I18nProvider>,
  );
}

describe("LastCheck", () => {
  it("says never run when nothing was recorded", () => {
    renderCheck(null, null);
    expect(screen.getByText(/never/i)).toHaveAttribute("data-check", "never");
  });

  it("says passed, with the time it happened", () => {
    renderCheck(true, "2026-09-03T15:12:00.000Z");
    const el = screen.getByText(/writable/i);
    expect(el).toHaveAttribute("data-check", "passed");
    expect(el).toHaveTextContent("15:12");
  });

  it("says failed, which is a different answer from never", () => {
    renderCheck(false, "2026-09-03T15:12:00.000Z");
    expect(screen.getByText(/failed/i)).toHaveAttribute("data-check", "failed");
  });

  it("treats a recorded outcome with no timestamp as never run, not as a passed check", () => {
    // Defensive on the seam: a row written before the columns existed, or half-populated by a
    // future bug, must not be reported as proven.
    renderCheck(true, null);
    expect(screen.getByText(/never/i)).toHaveAttribute("data-check", "never");
  });
});
