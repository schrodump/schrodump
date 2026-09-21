// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The schedule column: the cron is the source of truth, and beside it the row says what it means
// on the instance's clock, naming that clock, and when the server says it fires next — rendered on
// the viewer's clock — or that it will not, and why.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { formatTime } from "@/lib/format";
import type { Policy } from "@/lib/types";
import { PolicyRow } from "./page";

const NOW = new Date(2026, 8, 8, 9, 40); // Tuesday 8 Sep 2026, 09:40 local
const TOMORROW_2AM = new Date(2026, 8, 9, 2, 0).toISOString();
const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// A zone whose clock reads differently from this machine's at NOW, whatever this machine's is.
const OTHER_ZONE = NOW.getTimezoneOffset() === 0 ? "America/Sao_Paulo" : "UTC";

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
  nextRunAt: TOMORROW_2AM,
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
  it("reads the cron in words on the instance's clock, names that clock, and says when it fires next", () => {
    wrap(<PolicyRow policy={base} timeZone={VIEWER_ZONE} now={NOW} />);
    expect(screen.getByText("0 2 * * *")).toBeInTheDocument();
    const reading = screen.getByTestId("cron-reading");
    expect(reading).toHaveTextContent(`every day at ${formatTime(new Date(2000, 0, 1, 2, 0).toISOString())} ${VIEWER_ZONE} ·`);
    // Same clock as the viewer's: nothing to disambiguate.
    expect(reading).toHaveTextContent(new RegExp(`· next tomorrow ${formatTime(TOMORROW_2AM)}$`));
  });

  // SC-01. The row used to compute the next run itself, on the browser's clock, while the
  // scheduler ran on UTC. It renders the server's answer now: a nextRunAt that disagrees with what
  // the browser would have computed is the one on screen.
  it("shows the server's next run, not one it worked out on the browser's clock", () => {
    // Tonight 23:17 on the viewer's clock. Minute 17 on purpose: "0 2 * * *" fires on the hour in
    // every zone either side of this test could use, so no local computation can land on it — a
    // round 23:00 is exactly 02:00 UTC for a São Paulo machine, and would let the row pass by
    // computing it itself.
    const serverSays = new Date(2026, 8, 8, 23, 17).toISOString();
    wrap(<PolicyRow policy={{ ...base, nextRunAt: serverSays }} timeZone={OTHER_ZONE} now={NOW} />);
    const reading = screen.getByTestId("cron-reading");
    expect(reading).toHaveTextContent(`next today ${formatTime(serverSays)} your time`);
    expect(reading).not.toHaveTextContent(`tomorrow ${formatTime(TOMORROW_2AM)}`);
    // And the expression is read on the instance's clock, which the sentence names.
    expect(reading).toHaveTextContent(new RegExp(`^every day at .+ ${OTHER_ZONE} ·`));
  });

  it("names no clock time while the instance's zone is unknown", () => {
    wrap(<PolicyRow policy={base} timeZone={null} now={NOW} />);
    const reading = screen.getByTestId("cron-reading");
    expect(reading).not.toHaveTextContent("every day at");
    expect(reading).toHaveTextContent(/^next tomorrow/);
  });

  it("names the zone even for a shape it has no sentence for", () => {
    wrap(<PolicyRow policy={{ ...base, cron: "0 2 * * 1-5" }} timeZone="UTC" now={NOW} />);
    expect(screen.getByTestId("cron-reading")).toHaveTextContent(/^in UTC · next/);
  });

  it("says a disabled policy is not scheduled instead of inventing a next run", () => {
    wrap(<PolicyRow policy={{ ...base, enabled: false, nextRunAt: null }} timeZone="UTC" now={NOW} />);
    expect(screen.getByTestId("cron-reading")).toHaveTextContent(/not scheduled — disabled$/);
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });

  it("says an unreadable expression does not parse, in the caution tone", () => {
    wrap(<PolicyRow policy={{ ...base, cron: "every night", nextRunAt: null }} timeZone="UTC" now={NOW} />);
    const reading = screen.getByTestId("cron-reading");
    expect(reading).toHaveTextContent("the expression does not parse");
    expect(reading.className).toContain("text-caution");
  });

  // Stored before the server validated it: the scheduler skips it on every tick and the server
  // answers nextRunAt null. The row must not name a clock time for it, nor a next run.
  it("says 30 February does not parse", () => {
    wrap(<PolicyRow policy={{ ...base, cron: "0 0 30 2 *", nextRunAt: null }} timeZone="UTC" now={NOW} />);
    const reading = screen.getByTestId("cron-reading");
    expect(reading).toHaveTextContent(/^the expression does not parse$/);
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
