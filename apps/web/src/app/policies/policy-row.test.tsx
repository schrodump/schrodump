// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The schedule column: the cron is the source of truth, and beside it the row says what it means
// and when it fires next on the viewer's clock — or that it will not, and why.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Policy } from "@/lib/types";
import { PolicyRow } from "./page";

const NOW = new Date(2026, 8, 8, 9, 40); // Tuesday 8 Sep 2026, 09:40 local

const base: Policy = {
  id: "p1",
  name: "nightly-eu",
  targetId: "t1",
  destinationId: "d1",
  cron: "0 2 * * *",
  keepLast: 7,
  keepDaily: 0,
  keepWeekly: 4,
  keepMonthly: 6,
  keepYearly: 1,
  minAgeBeforeDeleteMs: 0,
  verifyLevel: "FULL_RESTORE",
  executionMode: "STREAM",
  parallelism: 1,
  compression: "zstd",
  enabled: true,
};

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("PolicyRow schedule", () => {
  it("reads the cron in words and says when it fires next", () => {
    wrap(<PolicyRow policy={base} now={NOW} />);
    expect(screen.getByText("0 2 * * *")).toBeInTheDocument();
    // 02:00 has passed today, so the next firing is tomorrow at 02:00 on the local clock.
    expect(screen.getByTestId("cron-reading")).toHaveTextContent(/^every day at 0?2:00 (AM )?· next tomorrow 0?2:00/);
  });

  it("says a disabled policy is not scheduled instead of inventing a next run", () => {
    wrap(<PolicyRow policy={{ ...base, enabled: false }} now={NOW} />);
    expect(screen.getByTestId("cron-reading")).toHaveTextContent(/not scheduled — disabled$/);
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });

  it("says an unreadable expression does not parse, in the caution tone", () => {
    wrap(<PolicyRow policy={{ ...base, cron: "every night" }} now={NOW} />);
    const reading = screen.getByTestId("cron-reading");
    expect(reading).toHaveTextContent("the expression does not parse");
    expect(reading.className).toContain("text-caution");
  });

  it("shows the keep counters in the L/D/W/M/Y order the header names", () => {
    wrap(<PolicyRow policy={base} now={NOW} />);
    expect(screen.getByText("7 / 0 / 4 / 6 / 1")).toBeInTheDocument();
  });
});

describe("PolicyRow warnings", () => {
  it("keeps the verify-off warning on the row, in the caution tone, never as a toast", () => {
    wrap(<PolicyRow policy={{ ...base, verifyLevel: "NONE" }} now={NOW} />);
    expect(screen.getByText("Verify is off for this policy")).toBeInTheDocument();
    expect(screen.getByText("verify · Off").className).toContain("text-caution");
  });

  it("warns that all-zero retention keeps everything forever", () => {
    wrap(<PolicyRow policy={{ ...base, keepLast: 0, keepWeekly: 0, keepMonthly: 0, keepYearly: 0 }} now={NOW} />);
    expect(screen.getByText("This policy is retaining every backup, forever")).toBeInTheDocument();
  });

  it("shows no action to a viewer and the four to an operator", async () => {
    wrap(<PolicyRow policy={base} now={NOW} role="viewer" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("asks before deleting, and says why disabling is usually the better move", async () => {
    const user = userEvent.setup();
    wrap(<PolicyRow policy={base} now={NOW} role="operator" onEdit={() => undefined} />);
    expect(screen.getByRole("button", { name: "Run backup now" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/disabling is usually the right move/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete policy" })).toBeEnabled();
  });
});
