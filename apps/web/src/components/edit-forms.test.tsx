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
import { formatTime } from "@/lib/format";
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
  // One database, because that is the only postgres scope that backs up what it names: pg_dump
  // copies exactly one, and this fixture used to carry two — the shape that silently backed up the
  // first and dropped the second, and that the form and the API now refuse.
  scope: { databases: ["app"], schemas: [], collections: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  lastProbeAt: null,
  lastProbeOk: null,
  lastProbeFailure: null,
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
  lastCanaryAt: null,
  lastCanaryOk: null,
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
  nextRunAt: "2026-01-02T03:00:00.000Z",
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

// "Save" on the destination and policy forms, "Save changes" on the target form.
const save = () => screen.getByRole("button", { name: /^Save/ });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TargetForm in edit mode", () => {
  it("seeds from the target, including the databases already scoped", () => {
    captureFetch();
    renderWith(<TargetForm onDone={() => undefined} target={TARGET} />);
    expect(screen.getByLabelText("Host")).toHaveValue("db.internal");
    // The scope is a selection, not a text field: with no discovery run, the saved one is shown.
    expect(screen.getByText(/Currently: app/)).toBeInTheDocument();
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

describe("PolicyForm refuses what the scheduler could not run", () => {
  it("blocks Save with the reason while the cron does not parse", async () => {
    captureFetch();
    const user = renderWith(<PolicyForm onDone={() => undefined} scratchConfigured policy={POLICY} />);
    await user.clear(screen.getByLabelText("Schedule (cron)"));
    await user.type(screen.getByLabelText("Schedule (cron)"), "every night");
    expect(save()).toBeDisabled();
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/does not parse as five-field cron/i);
  });

  // SC-02: the form accepted 30 February because every field was in range, and the server stored
  // it. It can never fire; Save is blocked on the same path as any expression that does not parse.
  it.each(["0 0 30 2 *", "0 0 31 4 *"])("blocks Save for %j, which can never fire", async (cron) => {
    const { calls } = captureFetch();
    const user = renderWith(<PolicyForm onDone={() => undefined} scratchConfigured policy={POLICY} timeZone="UTC" />);
    await user.clear(screen.getByLabelText("Schedule (cron)"));
    await user.type(screen.getByLabelText("Schedule (cron)"), cron);
    expect(save()).toBeDisabled();
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/does not parse as five-field cron/i);
    expect(screen.getByTestId("cron-reading")).toHaveTextContent("the expression does not parse");
    await user.click(save());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("withholds the staged mode, with its reason, when scratch is not configured", () => {
    captureFetch();
    renderWith(<PolicyForm onDone={() => undefined} scratchConfigured={false} policy={POLICY} />);
    expect(screen.getByRole("option", { name: "Staged" })).toBeDisabled();
    expect(screen.getByText(/Staged needs scratch, which is not configured/)).toBeInTheDocument();
    expect(screen.getByLabelText("Parallelism")).toBeDisabled();
  });
});

// SC-01: the preview walked the browser's clock while the scheduler ran on the instance's. It
// reads the expression being typed on the instance's zone now, names it, and renders the next run
// on the viewer's clock. `Date` alone is faked, so user-event's timers still run.
describe("PolicyForm previews on the instance's clock", () => {
  const NOW = new Date("2026-09-21T12:00:00.000Z");
  // Two zones on either side of UTC; whichever this machine is not in.
  const tokyo = NOW.getTimezoneOffset() === -540;
  const ZONE = tokyo ? "America/Sao_Paulo" : "Asia/Tokyo";
  const NEXT = tokyo ? "2026-09-22T05:00:00.000Z" : "2026-09-21T17:00:00.000Z";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts the next 02:00 where that zone's clock reads 02:00", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    captureFetch();
    const user = renderWith(<PolicyForm onDone={() => undefined} scratchConfigured timeZone={ZONE} />);
    await user.clear(screen.getByLabelText("Schedule (cron)"));
    await user.type(screen.getByLabelText("Schedule (cron)"), "0 2 * * *");
    const reading = screen.getByTestId("cron-reading");
    expect(reading).toHaveTextContent(new RegExp(`^every day at .+ ${ZONE} · next`));
    expect(reading).toHaveTextContent(formatTime(NEXT));
  });

  it("names no clock time and no next run until the zone is known", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    captureFetch();
    renderWith(<PolicyForm onDone={() => undefined} scratchConfigured timeZone={null} />);
    expect(screen.getByTestId("cron-reading")).toHaveTextContent(/^$/);
  });
});

describe("PolicyForm's verify default", () => {
  // The product's claim is that a backup is not trusted until a restore has verified it; the form
  // used to start every new policy at CHECKSUM, a hash of the bytes.
  it("starts a new policy at full restore where the deployment can run one", () => {
    captureFetch();
    renderWith(<PolicyForm onDone={() => undefined} scratchConfigured />);
    expect(screen.getByLabelText("Verify level")).toHaveValue("FULL_RESTORE");
  });

  it("starts at checksum where a full restore could only end 'could not run'", () => {
    captureFetch();
    renderWith(<PolicyForm onDone={() => undefined} scratchConfigured={false} />);
    expect(screen.getByLabelText("Verify level")).toHaveValue("CHECKSUM");
  });

  it("keeps an existing policy's level as it is", () => {
    captureFetch();
    renderWith(<PolicyForm onDone={() => undefined} scratchConfigured policy={POLICY} />);
    expect(screen.getByLabelText("Verify level")).toHaveValue("CHECKSUM");
  });
});

describe("DestinationForm says why Save is blocked", () => {
  it("names the first missing field, in the order the form is filled", async () => {
    captureFetch();
    const user = renderWith(<DestinationForm onDone={() => undefined} />);
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/name the destination/i);
    await user.type(screen.getByLabelText("Name"), "r2");
    expect(screen.getByTestId("button-blocked-reason")).toHaveTextContent(/a region is required/i);
  });
});

