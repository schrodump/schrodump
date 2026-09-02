// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What the operator can actually tell about an artifact by looking at it.
//
// sourceHasOplog is the difference between an archive whose collections all land on ONE instant
// when restored and one where they do not. The server recorded it, the API dropped it, and the row
// showed engine, size and key — so two mongo artifacts looked identical.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Artifact } from "@/lib/types";
import { ArtifactRow } from "./page";

const base: Artifact = {
  id: "artifact-1",
  jobId: "job-1",
  destinationId: "destination-1",
  state: "VERIFIED",
  bucketKey: "org/shop/2026-01-01.archive",
  manifestKey: "org/shop/2026-01-01.manifest.json",
  engine: "mongodb",
  executionMode: "STREAM",
  sourceHasOplog: null,
  serverVersionNum: 80_000,
  sizeRawBytes: 4096,
  sizeCompressedBytes: 1024,
  checksumAlgorithm: "sha256",
  checksum: "deadbeef",
  compression: "zstd",
  keyIds: ["age1operational"],
  dependsOn: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function renderRow(artifact: Artifact): ReactNode | void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ArtifactRow artifact={artifact} role="operator" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

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
