// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The card this replaces said "This data needs a server endpoint that is not available yet" while
// every value below was already decided at boot — knowable only by reading the .env on the host,
// which is the file an operator opens the interface to stop guessing about.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Instance } from "@/lib/types";
import { InstancePanel } from "./instance-panel";

const INSTANCE: Instance = {
  version: "0.1.0-rc.1",
  scratch: {
    configured: true,
    path: "/var/lib/schrodump/scratch",
    maxBytes: 107374182400,
    maxConcurrentStaged: 2,
  },
  stagedThresholdBytes: null,
  executorNetwork: "schrodump_targets",
  selfBackup: { configured: true, intervalMs: 86400000 },
  notifyMinGapMs: 900000,
  shutdownGraceMs: 8000,
};

function renderPanel(response: { ok: boolean; status: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body ?? {}),
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <InstancePanel />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InstancePanel", () => {
  it("names the build that is serving, which no page could answer before", async () => {
    renderPanel({ ok: true, status: 200, body: INSTANCE });
    expect(await screen.findByText("0.1.0-rc.1")).toBeInTheDocument();
  });

  it("shows the scratch path, the thing every mount failure in this product turned on", async () => {
    renderPanel({ ok: true, status: 200, body: INSTANCE });
    expect(await screen.findByText("/var/lib/schrodump/scratch")).toBeInTheDocument();
  });

  it("says what an unconfigured scratch actually costs, rather than showing a blank", async () => {
    // No scratch is STREAM-only: no staged dump, no verify sandbox, no restore. An operator
    // reading a dash learns nothing; this is the deployment's whole capability envelope.
    renderPanel({
      ok: true,
      status: 200,
      body: { ...INSTANCE, scratch: { ...INSTANCE.scratch, configured: false, path: null } },
    });
    expect(await screen.findByText(/stream/i)).toBeInTheDocument();
  });

  it("tells a non-admin why it is empty instead of reading as 'nothing here'", async () => {
    renderPanel({ ok: false, status: 403 });
    expect(await screen.findByText(/admin/i)).toBeInTheDocument();
  });

  it("says these values come from the environment and need a restart", async () => {
    // Read-only is a property of the deployment, not an unfinished feature: a staged dump in
    // flight is sized against the budget it started with. Saying so stops the next reader filing
    // the absence of a save button as a bug.
    renderPanel({ ok: true, status: 200, body: INSTANCE });
    expect(await screen.findByText(/restart/i)).toBeInTheDocument();
  });
});
