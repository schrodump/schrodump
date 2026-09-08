// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What the target row now shows that it never did: the scope it actually backs up, and WHY the last
// probe failed — not just that it did.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Target } from "@/lib/types";
import { TargetRow } from "./page";

const base: Target = {
  id: "t1",
  name: "IPOG 1",
  engine: "postgres",
  host: "db.internal",
  port: 5432,
  username: "backup",
  tls: false,
  scope: { databases: ["ipog_finance"], schemas: [], collections: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  lastProbeAt: null,
  lastProbeOk: null,
  lastProbeFailure: null,
};

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

// Exact matches, so each pins its own leaf and never the row that contains them all.
describe("TargetRow", () => {
  it("shows the scope it backs up", () => {
    wrap(<TargetRow target={base} />);
    expect(screen.getByText("Scope: ipog_finance")).toBeInTheDocument();
  });

  it("says 'whole instance' when nothing is scoped, never a blank", () => {
    wrap(<TargetRow target={{ ...base, scope: { databases: [], schemas: [], collections: [] } }} />);
    expect(screen.getByText("Scope: Whole instance")).toBeInTheDocument();
  });

  it("says WHY the last probe failed, not just that it did", () => {
    wrap(
      <TargetRow
        target={{
          ...base,
          lastProbeAt: "2026-01-01T00:00:00.000Z",
          lastProbeOk: false,
          lastProbeFailure: "AUTH_FAILED",
        }}
      />,
    );
    expect(screen.getByText("The server refused those credentials.")).toBeInTheDocument();
  });

  it("stays quiet about a reason when the probe passed", () => {
    wrap(
      <TargetRow
        target={{ ...base, lastProbeAt: "2026-01-01T00:00:00.000Z", lastProbeOk: true, lastProbeFailure: null }}
      />,
    );
    expect(screen.queryByText("The server refused those credentials.")).toBeNull();
  });
});
