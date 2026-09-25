// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What the operator can actually tell about an artifact by looking at it.
//
// sourceHasOplog is the difference between an archive whose collections all land on ONE instant
// when restored and one where they do not. The server recorded it, the API dropped it, and the row
// showed engine, size and key — so two mongo artifacts looked identical.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Role } from "@/lib/domain";
import type { Artifact } from "@/lib/types";
import { ArtifactRow } from "./page";

const base: Artifact = {
  id: "artifact-1",
  jobId: "job-1",
  destinationId: "destination-1",
  targetName: null,
  policyName: null,
  restoreInto: null,
  state: "VERIFIED",
  verifiedLevel: null,
  verifiedDegraded: false,
  bucketKey: "org/shop/2026-01-01.archive",
  manifestKey: "org/shop/2026-01-01.manifest.json",
  engine: "mongodb",
  executionMode: "STREAM",
  sourceHasOplog: null,
  dumpIsMultiDatabase: null,
  rolePasswordsCaptured: null,
  serverVersionNum: 80_000,
  sizeRawBytes: 4096,
  sizeCompressedBytes: 1024,
  checksumAlgorithm: "sha256",
  checksum: "deadbeef",
  compression: "zstd",
  keyIds: ["age1operational"],
  serverCanDecrypt: true,
  dependsOn: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderRow(
  artifact: Artifact,
  destinationName: string | null = "Cloudflare R2",
  role: Role = "operator",
): ReactNode | void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ArtifactRow artifact={artifact} role={role} destinationName={destinationName} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The whole point of #1: a green proven by a real restore must not look like one only checksummed,
// and a checksum that was DOWNGRADED from a requested full restore (an unscoped replica-set dump)
// must read as a caution — otherwise the dashboard blurs "it restores" into "its bytes are intact",
// which is the one distinction the product exists to keep.
describe("ArtifactRow and how the green was earned", () => {
  it("marks a downgraded checksum as a caution beside the green", () => {
    renderRow({ ...base, state: "VERIFIED", verifiedLevel: "CHECKSUM", verifiedDegraded: true });
    const chip = screen.getByTestId("verify-level-CHECKSUM-degraded");
    expect(chip).toHaveTextContent(/checksum only/i);
    // It carries the reason for the operator who hovers it.
    expect(chip.getAttribute("title")).toMatch(/full restore is not possible/i);
  });

  it("states a real full restore quietly, without the caution testid", () => {
    renderRow({ ...base, state: "VERIFIED", verifiedLevel: "FULL_RESTORE", verifiedDegraded: false });
    expect(screen.getByTestId("verify-level-FULL_RESTORE")).toBeTruthy();
    expect(screen.queryByTestId("verify-level-FULL_RESTORE-degraded")).toBeNull();
  });

  it("shows a requested (undegraded) checksum as neutral, not a caution", () => {
    renderRow({ ...base, state: "VERIFIED", verifiedLevel: "CHECKSUM", verifiedDegraded: false });
    expect(screen.getByTestId("verify-level-CHECKSUM")).toBeTruthy();
    expect(screen.queryByTestId("verify-level-CHECKSUM-degraded")).toBeNull();
  });

  it("says nothing about a level that was never recorded — null is not a false 'checksum'", () => {
    renderRow({ ...base, state: "VERIFIED", verifiedLevel: null, verifiedDegraded: false });
    expect(screen.queryByTestId("verify-level-CHECKSUM")).toBeNull();
    expect(screen.queryByTestId("verify-level-FULL_RESTORE")).toBeNull();
  });
});

describe("ArtifactRow and the oplog fact", () => {
  it("says so when the archive carries an oplog", () => {
    renderRow({ ...base, sourceHasOplog: true });
    expect(screen.getByText(/oplog/i)).toBeTruthy();
  });

  it("stays silent when a mongo dump carries none", () => {
    renderRow({ ...base, sourceHasOplog: false });
    expect(screen.queryByText(/oplog/i)).toBeNull();
  });

  it("stays silent for an engine that has no oplog at all", () => {
    // null, not false. Rendering "no oplog" for postgres would assert something about a database
    // that has none — the same distinction the API mapper preserves.
    renderRow({ ...base, engine: "postgres", sourceHasOplog: null });
    expect(screen.queryByText(/oplog/i)).toBeNull();
  });
});

// A postgres artifact taken by a least-privilege role (every managed service's master user) carries
// its roles without their passwords. Restoring it brings back roles that cannot log in, and the
// row is where that should be read — not the middle of a restore.
describe("ArtifactRow and the role-password fact", () => {
  const postgres = (rolePasswordsCaptured: boolean | null): Artifact => ({
    ...base,
    engine: "postgres",
    rolePasswordsCaptured,
  });

  it("says so, as a caution, when role passwords were not captured", () => {
    renderRow(postgres(false));
    const value = screen.getByText(/not captured/i);
    expect(value.className).toMatch(/text-caution/);
    expect(screen.getByText(/role passwords/i)).toBeTruthy();
  });

  it("states a capture plainly", () => {
    renderRow(postgres(true));
    const value = screen.getByText(/^captured$/i);
    expect(value.className).not.toMatch(/text-caution/);
  });

  it("stays silent when it was never recorded — null is not a 'not captured'", () => {
    renderRow(postgres(null));
    expect(screen.queryByText(/role passwords/i)).toBeNull();
    expect(screen.queryByText(/captured/i)).toBeNull();
  });
});

// Nineteen fields, scanned in a hurry. The row used to lead with the bucket key — a 60-character
// storage path, the least useful thing on it — and spell the checksum out beside it, so five rows
// filled a screen and none of them answered "can I recover?" at a glance.
//
// Two tiers now: what carries the scan stays on the summary line, and the forensic fields open in
// place. Nothing moved off the page; a native <details> keeps it one keystroke away rather than
// one route away.
describe("ArtifactRow — two tiers", () => {
  function summaryOf(): HTMLElement {
    const summary = document.querySelector("summary");
    if (summary === null) throw new Error("the row is not a disclosure");
    return summary as HTMLElement;
  }

  it("leads the scan with state, engine and size", () => {
    renderRow({ ...base, state: "UNOBSERVED", sizeCompressedBytes: 1024 });
    const summary = summaryOf();
    expect(summary).toHaveTextContent(/unobserved/i);
    expect(summary).toHaveTextContent(/mongodb/i);
    expect(summary).toHaveTextContent(/1\.0 KB/i);
  });

  it("keeps the bucket key and the checksum off the scan line", () => {
    // They are forensic: needed exactly once, during an incident, and never while scanning.
    renderRow(base);
    const summary = summaryOf();
    expect(summary).not.toHaveTextContent("org/shop/2026-01-01.archive");
    expect(summary).not.toHaveTextContent("deadbeef");
  });

  it("still carries them, one disclosure away rather than one page away", () => {
    renderRow(base);
    expect(screen.getByText(/org\/shop\/2026-01-01\.archive/)).toBeInTheDocument();
    expect(screen.getByText(/deadbeef/)).toBeInTheDocument();
  });

  it("opens and closes without script, so the keyboard reaches it", () => {
    renderRow(base);
    const row = document.querySelector("details");
    expect(row).not.toBeNull();
    expect(row).not.toHaveAttribute("open");
    summaryOf().click();
    expect(row).toHaveAttribute("open");
  });

  it("keeps the actions reachable without opening the row", () => {
    renderRow(base);
    const summary = summaryOf();
    expect(summary).toHaveTextContent(/verify/i);
  });
});

// The data the row used to drop on the floor: which destination it lives in, how hard it compressed
// (a backup of nothing "compresses" 1.0x), and — for a verified one — how fresh the verdict is.
describe("ArtifactRow enrichment", () => {
  it("resolves the destination name rather than leaving a cuid on screen", () => {
    renderRow(base, "Cloudflare R2");
    expect(screen.getByText("Cloudflare R2")).toBeInTheDocument();
  });

  it("falls back to the destination id when the name cannot be resolved", () => {
    renderRow({ ...base, destinationId: "dest-xyz" }, null);
    expect(screen.getByText("dest-xyz")).toBeInTheDocument();
  });

  it("shows the compression ratio derived from the two sizes (4 KiB -> 1 KiB = 4.0x)", () => {
    renderRow({ ...base, sizeRawBytes: 4096, sizeCompressedBytes: 1024 });
    expect(screen.getByText(/4\.0×/)).toBeInTheDocument();
  });

  it("stays silent about 'last verified' until a verify has reached a verdict", () => {
    renderRow({ ...base, verifiedLevel: null });
    expect(screen.queryByText(/last verified/i)).toBeNull();
  });

  it("shows 'last verified' once the artifact carries a verify level", () => {
    renderRow({ ...base, verifiedLevel: "FULL_RESTORE", updatedAt: base.createdAt });
    expect(screen.getByText(/last verified/i)).toBeInTheDocument();
  });
});

// Clicking Verify used to do nothing visible: no confirmation, and `verify.isError` was never
// rendered at all, so a refusal vanished. The operator was left to guess whether the click had
// registered — and then pressed F5 to find out, which is the habit this whole change removes.
describe("a triggered verify says what happened", () => {
  function stubVerify(answer: { ok: boolean; body: unknown; status?: number }) {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: answer.ok,
        status: answer.status ?? (answer.ok ? 200 : 403),
        statusText: "Forbidden",
        json: () => Promise.resolve(answer.body),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("confirms the queued job and links the ledger", async () => {
    stubVerify({ ok: true, body: { jobId: "cmtqofm340015nv7icksk39yj" } });
    renderRow({ ...base, state: "UNOBSERVED" });
    await userEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    // The status node exists only once the mutation resolved — the data-dependent signal. Asserting
    // on the text alone would pass on the render before the request ever answered.
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("cmtqofm");
    expect(screen.getByRole("link", { name: /ledger/i })).toHaveAttribute("href", "/jobs");
  });

  it("keeps the artifact's state the server's — a queued verify is not a green", async () => {
    stubVerify({ ok: true, body: { jobId: "job-1" } });
    renderRow({ ...base, state: "UNOBSERVED" });
    await userEvent.click(screen.getByRole("button", { name: /^verify$/i }));
    await screen.findByRole("status");

    const summary = document.querySelector("summary");
    expect(summary).toHaveTextContent(/unobserved/i);
    expect(summary).not.toHaveTextContent(/verified/i);
  });

  it("renders a refusal inline instead of dropping it", async () => {
    stubVerify({ ok: false, body: { error: "operator role required" } });
    renderRow({ ...base, state: "UNOBSERVED" });
    await userEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/operator role required/i);
  });
});

// The same two-lock shape as restore and delete: the server requires operator+ on the verify route,
// and a control whose only outcome is a 403 is worse than no control.
describe("verify is operator+, and the button says so by not being there", () => {
  it("offers Verify to an operator", () => {
    renderRow({ ...base, state: "UNOBSERVED" }, "Cloudflare R2", "operator");
    expect(screen.getByRole("button", { name: /^verify$/i })).toBeInTheDocument();
  });

  it("shows a viewer no verify control at all", () => {
    renderRow({ ...base, state: "UNOBSERVED" }, "Cloudflare R2", "viewer");
    expect(screen.queryByRole("button", { name: /verify/i })).toBeNull();
    // The row is still fully readable — hiding the action never hides the evidence.
    expect(document.querySelector("summary")).toHaveTextContent(/unobserved/i);
  });
});
