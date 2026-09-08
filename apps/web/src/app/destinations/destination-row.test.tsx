// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Where the bucket actually lives, which the row never showed: two R2 accounts and an S3 one were
// indistinguishable. region, endpoint and the path-style flag are each their own leaf span.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Destination } from "@/lib/types";
import { DestinationRow } from "./page";

const base: Destination = {
  id: "d1",
  name: "Cloudflare R2",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "schrodump",
  prefix: "",
  accessKeyId: "AKIA_example",
  forcePathStyle: true,
  sealMode: "operational",
  lastCanaryAt: null,
  lastCanaryOk: null,
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

describe("DestinationRow", () => {
  it("shows the region and endpoint the bucket lives at", () => {
    wrap(<DestinationRow destination={base} />);
    expect(screen.getByText("auto")).toBeInTheDocument();
    expect(screen.getByText("https://acct.r2.cloudflarestorage.com")).toBeInTheDocument();
  });

  it("flags path-style when the destination requires it", () => {
    wrap(<DestinationRow destination={base} />);
    expect(screen.getByText("path-style")).toBeInTheDocument();
  });

  it("omits path-style when it is off, and the endpoint when it is the AWS default", () => {
    wrap(<DestinationRow destination={{ ...base, endpoint: null, forcePathStyle: false }} />);
    expect(screen.queryByText("path-style")).toBeNull();
    expect(screen.queryByText("https://acct.r2.cloudflarestorage.com")).toBeNull();
  });
});
