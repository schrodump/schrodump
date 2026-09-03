// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The checklist used to ask for two things it could never tick off: the destination canary and the
// target probe ran, answered one browser, and were forgotten. An operator who did exactly as asked
// watched the same two items stay open forever, which teaches them the list is decorative.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Destination, Target } from "@/lib/types";
import { GuidedSetup } from "./guided-setup";

const DESTINATION: Destination = {
  id: "d1",
  name: "prod-s3",
  endpoint: null,
  region: "us-east-1",
  bucket: "backups",
  prefix: "schrodump",
  accessKeyId: "AKIAEXAMPLE",
  forcePathStyle: false,
  sealMode: "operational",
  lastCanaryAt: null,
  lastCanaryOk: null,
};

const TARGET: Target = {
  id: "t1",
  name: "prod-db",
  engine: "postgres",
  host: "db.internal",
  port: 5432,
  username: "backup",
  tls: true,
  scope: { databases: ["app"], schemas: [], collections: [] },
  createdAt: "2026-09-01T00:00:00.000Z",
  lastProbeAt: null,
  lastProbeOk: null,
  lastProbeFailure: null,
};

// Keys and a verifying policy are present throughout: this suite is about the other two steps, and
// the card hides itself once everything is done.
function renderWith(over: { destinations?: Destination[]; targets?: Target[] } = {}) {
  const bodies: Record<string, unknown> = {
    "/backend/encryption-keys": [
      { keyId: "esc", type: "escrow", state: "active", publicRecipient: "age1", serverCanDecrypt: false, createdAt: "" },
    ],
    "/backend/destinations": over.destinations ?? [DESTINATION],
    "/backend/targets": over.targets ?? [TARGET],
    "/backend/policies": [{ id: "p1", verifyLevel: "FULL_RESTORE" }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(bodies[url] ?? []) }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <GuidedSetup />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Every assertion below waits for the SETTLED card first. Without that they pass on the loading
// flash: before the four queries resolve, every condition is false and the card renders in full —
// so a naive findByText succeeds against a card that is about to unmount, and the test proves
// nothing. `settled` keys off a step whose done-ness can only come from fetched data.
async function settled(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByText(/encryption keys/i).closest("li")).toHaveAttribute("data-done", "true"),
  );
}

describe("GuidedSetup — the canary and probe steps close", () => {
  it("keeps asking while no canary has passed", async () => {
    renderWith();
    await settled();
    expect(screen.getByText(/canary/i).closest("li")).not.toHaveAttribute("data-done", "true");
  });

  it("ticks the canary off once one has passed", async () => {
    renderWith({
      destinations: [{ ...DESTINATION, lastCanaryOk: true, lastCanaryAt: "2026-09-03T00:00:00.000Z" }],
    });
    await settled();
    expect(screen.getByText(/canary/i).closest("li")).toHaveAttribute("data-done", "true");
  });

  it("does not tick it off for a canary that ran and FAILED", async () => {
    // "Ran and failed" is not "done" — the destination still is not proven writable, and that is
    // the distinction the stored null/false/true exists to carry.
    renderWith({
      destinations: [{ ...DESTINATION, lastCanaryOk: false, lastCanaryAt: "2026-09-03T00:00:00.000Z" }],
    });
    await settled();
    expect(screen.getByText(/canary/i).closest("li")).not.toHaveAttribute("data-done", "true");
  });

  it("ticks the probe off once one has passed", async () => {
    renderWith({
      targets: [{ ...TARGET, lastProbeOk: true, lastProbeAt: "2026-09-03T00:00:00.000Z" }],
    });
    await settled();
    expect(screen.getByText(/connection/i).closest("li")).toHaveAttribute("data-done", "true");
  });

  it("stays on screen while the two checks are still open", async () => {
    // The card used to dismiss on keys + destination + target + policy alone, so it vanished while
    // still holding two unanswered items. A checklist that hides with work outstanding is worse
    // than one that never appeared.
    renderWith();
    await settled();
    expect(screen.getByText(/canary/i)).toBeInTheDocument();
  });

  it("hides itself once the two checks have passed as well", async () => {
    renderWith({
      destinations: [{ ...DESTINATION, lastCanaryOk: true, lastCanaryAt: "2026-09-03T00:00:00.000Z" }],
      targets: [{ ...TARGET, lastProbeOk: true, lastProbeAt: "2026-09-03T00:00:00.000Z" }],
    });
    await waitFor(() => expect(screen.queryByText(/canary/i)).toBeNull());
  });
});
