// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Edit mode is where the write-only credential contract is easiest to break. On create, a missing
// secret is an invalid form; on edit it MUST mean "keep the stored one", because the UI can never
// read the secret back to re-submit it. Sending "" instead would be a 400 at best, and an
// overwritten credential at worst. These tests assert the request body that actually goes out.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import type { Destination, Policy, Target } from "@/lib/types";
import { DestinationForm } from "./destination-form";
import { PolicyForm } from "./policy-form";
import { TargetForm } from "./target-form";

const TARGET: Target = {
  id: "t1",
  name: "prod-db",
  engine: "postgres",
  host: "db.internal",
  port: 5432,
  username: "backup",
  tls: true,
  scope: { databases: ["app", "shop"], schemas: [], collections: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
};

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
};

const POLICY: Policy = {
  id: "p1",
  name: "nightly",
  targetId: "t1",
  destinationId: "d1",
  cron: "0 3 * * *",
  keepLast: 7,
  keepDaily: 0,
  keepWeekly: 4,
  keepMonthly: 6,
  keepYearly: 1,
  minAgeBeforeDeleteMs: 0,
  verifyLevel: "CHECKSUM",
  executionMode: "STREAM",
  parallelism: 1,
  compression: "zstd",
  enabled: true,
};

// Captures what the form actually sends, which is the thing under test — asserting on a mocked
// hook would only prove the mock was called.
function captureFetch(): { calls: Array<{ method: string; url: string; body: unknown }> } {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
  return { calls };
}

function renderWith(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const save = () => screen.getByRole("button", { name: "Save" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TargetForm in edit mode", () => {
  it("seeds from the target, including the databases already scoped", () => {
    captureFetch();
    renderWith(<TargetForm onDone={() => undefined} target={TARGET} />);
    expect(screen.getByLabelText("Host")).toHaveValue("db.internal");
    expect(screen.getByLabelText(/Databases to back up/)).toHaveValue("app, shop");
  });

  it("locks the engine — every artifact records the engine it was taken with", () => {
    captureFetch();
    renderWith(<TargetForm onDone={() => undefined} target={TARGET} />);
    expect(screen.getByLabelText("Engine")).toBeDisabled();
  });

  it("PATCHes without a password when the field is left blank", async () => {
    const { calls } = captureFetch();
    const user = renderWith(<TargetForm onDone={() => undefined} target={TARGET} />);
    await user.clear(screen.getByLabelText("Host"));
    await user.type(screen.getByLabelText("Host"), "db2.internal");
    await user.click(save());

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/backend/targets/t1");
    expect(patch?.body).toMatchObject({ host: "db2.internal" });
    // The two that would break things: a blank password must not travel, and engine is refused.
    expect(patch?.body).not.toHaveProperty("password");
    expect(patch?.body).not.toHaveProperty("engine");
  });
});

describe("DestinationForm in edit mode", () => {
  it("locks bucket and prefix — artifact keys are stored relative to them", () => {
    captureFetch();
    renderWith(<DestinationForm onDone={() => undefined} destination={DESTINATION} />);
    expect(screen.getByLabelText("Bucket")).toBeDisabled();
    expect(screen.getByLabelText("Prefix")).toBeDisabled();
  });

  it("PATCHes without a secret when the field is left blank", async () => {
    const { calls } = captureFetch();
    const user = renderWith(<DestinationForm onDone={() => undefined} destination={DESTINATION} />);
    await user.clear(screen.getByLabelText("Region"));
    await user.type(screen.getByLabelText("Region"), "eu-west-1");
    await user.click(save());

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toMatchObject({ region: "eu-west-1" });
    expect(patch?.body).not.toHaveProperty("secretAccessKey");
    expect(patch?.body).not.toHaveProperty("bucket");
    expect(patch?.body).not.toHaveProperty("prefix");
  });
});

describe("PolicyForm in edit mode", () => {
  it("never sends targetId or destinationId — the server's schema is strict and would 400", async () => {
    const { calls } = captureFetch();
    const user = renderWith(
      <PolicyForm onDone={() => undefined} scratchConfigured policy={POLICY} />,
    );
    await user.clear(screen.getByLabelText("Schedule (cron)"));
    await user.type(screen.getByLabelText("Schedule (cron)"), "0 4 * * *");
    await user.click(save());

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/backend/policies/p1");
    expect(patch?.body).toMatchObject({ cron: "0 4 * * *", keepLast: 7 });
    expect(patch?.body).not.toHaveProperty("targetId");
    expect(patch?.body).not.toHaveProperty("destinationId");
  });
});
