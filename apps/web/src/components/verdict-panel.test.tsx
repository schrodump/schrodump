// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { DiscoverResult } from "@/lib/types";
import { VerdictPanel } from "./verdict-panel";

const ok: DiscoverResult = {
  ok: true,
  serverVersionNum: 160_004,
  failure: null,
  driverCode: null,
  databases: [],
  isReplicaSet: false,
};

function show(result: DiscoverResult, tls = true) {
  render(
    <I18nProvider>
      <VerdictPanel result={result} hostPort="db.internal:5432" user="ana" tls={tls} />
    </I18nProvider>,
  );
}

describe("VerdictPanel", () => {
  it("names the server it reached, how, and whether TLS was on", () => {
    show(ok);
    expect(screen.getByText("Connected.")).toBeInTheDocument();
    expect(screen.getByText("16.0.4 · db.internal:5432 · TLS required")).toBeInTheDocument();
  });

  it("says who was refused, without ever showing a secret", () => {
    show({ ...ok, ok: false, failure: "AUTH_FAILED" });
    expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    expect(screen.getByText("The server refused those credentials.")).toBeInTheDocument();
    expect(screen.getByText(/the username or password for ana is not/)).toBeInTheDocument();
  });

  it("explains a TLS failure differently when TLS is off", () => {
    show({ ...ok, ok: false, failure: "TLS_FAILED" }, false);
    expect(screen.getByText(/refused the plaintext connection/)).toBeInTheDocument();
  });

  it("shows the raw driver code only when the classification gave up", () => {
    show({ ...ok, ok: false, failure: "UNKNOWN", driverCode: "08P01" });
    expect(screen.getByText("code: 08P01 (raw, from the driver)")).toBeInTheDocument();
  });

  it("keeps the raw code out of a classified failure", () => {
    show({ ...ok, ok: false, failure: "TIMEOUT", driverCode: "ETIMEDOUT" });
    expect(screen.queryByText(/ETIMEDOUT/)).toBeNull();
  });
});
