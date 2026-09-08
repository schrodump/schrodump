// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Deletion is irreversible and reaches the bucket. The UI is the second lock (the server refuses a
// viewer regardless), and the friction — retype the id, and for a VERIFIED artifact tick an extra
// acknowledgement — is the guard against a reflexive click throwing away a proven-good backup.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Artifact } from "@/lib/types";
import { DeleteArtifactButton, DeleteArtifactDialog } from "./delete-artifact-dialog";

const base: Artifact = {
  id: "art01234deadbeef",
  jobId: "job-1",
  destinationId: "destination-1",
  state: "FAILED",
  verifiedLevel: null,
  verifiedDegraded: false,
  bucketKey: "org/shop/2026-01-01.archive",
  manifestKey: "org/shop/2026-01-01.manifest.json",
  engine: "postgres",
  executionMode: "STREAM",
  sourceHasOplog: null,
  dumpIsMultiDatabase: null,
  serverVersionNum: 160_002,
  sizeRawBytes: 4096,
  sizeCompressedBytes: 1024,
  checksumAlgorithm: "sha256",
  checksum: "deadbeef",
  compression: "zstd",
  keyIds: ["age1operational"],
  dependsOn: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const token = base.id.slice(0, 8);

function wrap(node: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const submit = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /delete permanently/i }) as HTMLButtonElement;

describe("DeleteArtifactButton visibility", () => {
  it("is hidden for a viewer", () => {
    wrap(<DeleteArtifactButton artifact={base} role="viewer" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is shown for an operator", () => {
    wrap(<DeleteArtifactButton artifact={base} role="operator" />);
    expect(screen.getByRole("button")).toBeTruthy();
  });
});

describe("DeleteArtifactDialog gating", () => {
  it("keeps delete disabled until the id is retyped exactly (FAILED needs no acknowledgement)", () => {
    wrap(<DeleteArtifactDialog artifact={base} onClose={() => undefined} />);
    // No acknowledgement checkbox for a non-VERIFIED artifact.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "wrong" } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: token } });
    expect(submit().disabled).toBe(false);
  });

  it("requires BOTH the retyped id and the acknowledgement for a VERIFIED artifact", () => {
    wrap(<DeleteArtifactDialog artifact={{ ...base, state: "VERIFIED" }} onClose={() => undefined} />);
    const ack = screen.getByRole("checkbox");
    expect(submit().disabled).toBe(true);
    // Right id, no acknowledgement → still blocked.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: token } });
    expect(submit().disabled).toBe(true);
    // Acknowledgement, but now clear the id → blocked again (both are required, not either).
    fireEvent.click(ack);
    expect(submit().disabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(submit().disabled).toBe(true);
  });
});
