// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { SelfBackup } from "@/lib/types";
import { SelfBackupPanel } from "./self-backup-panel";

const RUN: SelfBackup = {
  id: "sb-1",
  state: "SUCCEEDED",
  destinationId: "dest-1",
  bucketKey: "backups/_self/sb-1/metadata.bin",
  sizeBytes: 4096,
  reason: null,
  startedAt: "2026-09-01T00:00:00.000Z",
  finishedAt: "2026-09-01T00:01:00.000Z",
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
        <SelfBackupPanel />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("SelfBackupPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says the self-backup is unconfigured instead of showing an empty history", async () => {
    // An empty list on an unconfigured deployment looks exactly like an empty list on a configured
    // one that has never run. Only one of those is an operator's problem to fix right now.
    renderPanel({ ok: true, status: 200, body: { configured: false, items: [] } });
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText(/SCHRODUMP_SELF_BACKUP_DESTINATION_ID/)).toBeInTheDocument();
  });

  it("distinguishes configured-but-never-ran from unconfigured", async () => {
    renderPanel({ ok: true, status: 200, body: { configured: true, items: [] } });
    expect(await screen.findByText("Configured, but has never run.")).toBeInTheDocument();
    expect(screen.queryByText("Not configured")).toBeNull();
  });

  // The thesis, applied to this panel. A written self-backup is UNOBSERVED: a process exited 0 and
  // nobody restored it. Green would be the single place in this UI claiming a backup is good
  // because a job said so.
  it("paints a SUCCEEDED self-backup amber, never green", async () => {
    renderPanel({ ok: true, status: 200, body: { configured: true, items: [RUN] } });
    const badge = await screen.findByText("Written");
    expect(badge.className).toContain("--color-state-unobserved");
    expect(badge.className).not.toContain("--color-state-verified");
  });

  it("shows the failure reason on a failed run", async () => {
    renderPanel({
      ok: true,
      status: 200,
      body: {
        configured: true,
        items: [{ ...RUN, state: "FAILED", reason: "no active escrow key", sizeBytes: null }],
      },
    });
    expect(await screen.findByText(/no active escrow key/)).toBeInTheDocument();
  });

  it("explains the 403 for a non-admin rather than rendering an empty panel", async () => {
    renderPanel({ ok: false, status: 403 });
    expect(
      await screen.findByText("Only an admin can see the self-backup history."),
    ).toBeInTheDocument();
  });
});
