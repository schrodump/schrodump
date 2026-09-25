// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Nothing on these screens refreshed itself. The jobs ledger ticked a one-second clock over a list
// fetched once, so a job that finished at one minute went on reading "running 47m"; the catalog
// stayed amber after the verify that had already turned it green. Both looked broken, and both were
// only a missing refetch.
//
// Every assertion here waits for a DATA-dependent signal — a testid that exists only once the query
// has resolved, or a recorded request count — never a bare findByText, which passes on the loading
// flash.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveIndicator } from "@/components/live-indicator";
import { IDLE_POLL_MS, LIVE_POLL_MS, pollInterval, workInFlight } from "@/hooks/use-live-refresh";
import { useArtifacts, useJobs } from "@/hooks/use-resources";
import { I18nProvider } from "@/i18n/provider";
import type { ArtifactState, JobKind, JobState } from "@/lib/domain";
import type { Artifact, ArtifactList, Job, JobList } from "@/lib/types";

const NO_STATES: Record<JobState, number> = {
  PENDING: 0,
  RUNNING: 0,
  SUCCEEDED: 0,
  FAILED: 0,
  INCONCLUSIVE: 0,
  CANCELLED: 0,
};
const NO_KINDS: Record<JobKind, number> = { BACKUP: 0, RESTORE: 0, VERIFY: 0, RETENTION: 0 };

const job: Job = {
  id: "job-1",
  policyId: "policy-1",
  targetName: "orders",
  policyName: "nightly",
  kind: "VERIFY",
  state: "RUNNING",
  correlationId: "verify:job-1",
  scheduledAt: null,
  artifactId: "artifact-1",
  startedAt: "2026-09-07T17:08:06.000Z",
  finishedAt: null,
  exitCode: null,
  stderr: null,
  reason: null,
  artifact: { id: "artifact-1", state: "UNOBSERVED" },
  restoreTarget: null,
  createdAt: "2026-09-07T17:08:06.000Z",
};

function jobsPayload(state: JobState): JobList {
  return {
    items: [{ ...job, state }],
    total: 1,
    counts: { byState: { ...NO_STATES, [state]: 1 }, byKind: { ...NO_KINDS, VERIFY: 1 } },
    stats: { oldestPendingScheduledAt: null, failedLast24h: 0, inconclusiveLast24h: 0 },
  };
}

const artifact: Artifact = {
  id: "artifact-1",
  jobId: "job-0",
  destinationId: "destination-1",
  targetName: "orders",
  policyName: "nightly",
  restoreInto: null,
  state: "UNOBSERVED",
  verifiedLevel: null,
  verifiedDegraded: false,
  bucketKey: "org/orders/2026-09-07.dump",
  manifestKey: "org/orders/2026-09-07.manifest.json",
  engine: "postgres",
  executionMode: "STREAM",
  sourceHasOplog: null,
  dumpIsMultiDatabase: null,
  rolePasswordsCaptured: null,
  serverVersionNum: 160_004,
  sizeRawBytes: 4096,
  sizeCompressedBytes: 1024,
  checksumAlgorithm: "sha256",
  checksum: "deadbeef",
  compression: "zstd",
  keyIds: ["age1operational"],
  serverCanDecrypt: true,
  dependsOn: [],
  createdAt: "2026-09-07T17:00:00.000Z",
  updatedAt: "2026-09-07T17:00:00.000Z",
};

function artifactsPayload(state: ArtifactState): ArtifactList {
  return {
    items: [{ ...artifact, state }],
    total: 1,
    counts: {
      VERIFIED: state === "VERIFIED" ? 1 : 0,
      UNOBSERVED: state === "UNOBSERVED" ? 1 : 0,
      FAILED: state === "FAILED" ? 1 : 0,
    },
    verifiedByLevel: { FULL_RESTORE: state === "VERIFIED" ? 1 : 0, CHECKSUM: 0 },
    destinations: 1,
    oldestUnobserved: null,
  };
}

// One queue of answers per path, so a test can say "the second time you are asked about the jobs,
// the run is over" — which is exactly the situation a poll has to notice.
function serve(answers: { jobs?: JobList[]; artifacts?: ArtifactList[] }) {
  const counts = { jobs: 0, artifacts: 0 };
  const pick = <T,>(queue: T[], seen: number): T => queue[Math.min(seen, queue.length - 1)]!;
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    const path = url.includes("/artifacts") ? "artifacts" : "jobs";
    const body =
      path === "artifacts"
        ? pick(answers.artifacts ?? [artifactsPayload("UNOBSERVED")], counts.artifacts++)
        : pick(answers.jobs ?? [jobsPayload("SUCCEEDED")], counts.jobs++);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return counts;
}

// refetchIntervalInBackground is TRUE here on purpose. TanStack would happily poll a hidden tab
// with it on, so the only thing that can stop the hidden-tab test polling is OUR gate — otherwise
// the test would pass with the gate deleted, which is the definition of a vacuous test.
function renderLive(ui: ReactNode, options?: { refetchOnWindowFocus?: boolean }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchIntervalInBackground: true,
        refetchOnWindowFocus: options?.refetchOnWindowFocus ?? false,
      },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
  return client;
}

// The probes render nothing until their query has resolved, so every getByTestId below is itself
// the data-dependent signal.
function JobsProbe() {
  const jobs = useJobs();
  if (jobs.data === undefined) return null;
  return <p data-testid="jobs">{jobs.data.items.map((row) => `${row.id}:${row.state}`).join(",")}</p>;
}

function ArtifactsProbe() {
  const artifacts = useArtifacts();
  if (artifacts.data === undefined) return null;
  return (
    <p data-testid="artifacts">{artifacts.data.items.map((row) => `${row.id}:${row.state}`).join(",")}</p>
  );
}

// Advance the fake clock, then let the request the last timer fired actually land: `fetch` and
// `response.json()` resolve in microtasks after the tick has returned, and the cache notifies React
// in one more. Without the drain the assertion reads the screen mid-flight — which is how a test
// ends up passing on the loading flash instead of on data.
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  // The response the last timer asked for lands in a microtask after that tick has moved on, and
  // the cache then schedules its notification to React on a timer of its own. One more millisecond
  // is what delivers that render. Without it every assertion below would read the screen
  // mid-flight — which is exactly how a test ends up passing on the loading flash instead of on
  // data, and this repo has been bitten by that before.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The cadence is a pure function of two facts, so it is asserted as one rather than inferred from
// timing. Both branches matter: a screen stuck on the fast rate hammers an idle server, and a
// screen stuck on the slow one is the defect this fixes.
describe("the polling policy", () => {
  it("reads 'in flight' from the server's counts over the whole table, never from the page", () => {
    // The page is capped at two hundred rows. A ledger that decided it was idle because the running
    // job had fallen off the page would go quiet at exactly the moment it must not.
    const offThePage: JobList = {
      ...jobsPayload("SUCCEEDED"),
      counts: { byState: { ...NO_STATES, SUCCEEDED: 1, RUNNING: 1 }, byKind: { ...NO_KINDS, VERIFY: 2 } },
    };
    expect(offThePage.items.some((row) => row.state === "RUNNING")).toBe(false);
    expect(workInFlight(offThePage)).toBe(true);
  });

  it("counts a queued job as work in flight, and a settled table as none", () => {
    expect(workInFlight(jobsPayload("PENDING"))).toBe(true);
    expect(workInFlight(jobsPayload("RUNNING"))).toBe(true);
    expect(workInFlight(jobsPayload("SUCCEEDED"))).toBe(false);
    expect(workInFlight(jobsPayload("FAILED"))).toBe(false);
    expect(workInFlight(undefined)).toBe(false);
  });

  it("is fast while work is in flight, slow when it is not, and off when nobody is looking", () => {
    expect(pollInterval(true, true)).toBe(LIVE_POLL_MS);
    expect(pollInterval(true, false)).toBe(IDLE_POLL_MS);
    expect(pollInterval(false, true)).toBe(false);
    expect(pollInterval(false, false)).toBe(false);
    // The short interval has to be short enough that a one-second clock is not lying for long, and
    // the long one long enough not to be a poll loop.
    expect(LIVE_POLL_MS).toBeGreaterThanOrEqual(3_000);
    expect(LIVE_POLL_MS).toBeLessThanOrEqual(5_000);
    expect(IDLE_POLL_MS).toBeGreaterThanOrEqual(LIVE_POLL_MS * 2);
  });
});

describe("the jobs ledger refetches under its own clock", () => {
  it("shows the run finishing without a reload", async () => {
    serve({ jobs: [jobsPayload("RUNNING"), jobsPayload("SUCCEEDED")] });
    renderLive(<JobsProbe />);
    await settle();
    expect(screen.getByTestId("jobs")).toHaveTextContent("job-1:RUNNING");

    await settle(LIVE_POLL_MS);
    expect(screen.getByTestId("jobs")).toHaveTextContent("job-1:SUCCEEDED");
  });

  it("backs off once nothing is running, and still notices a new run at the slow rate", async () => {
    const counts = serve({ jobs: [jobsPayload("SUCCEEDED"), jobsPayload("PENDING")] });
    renderLive(<JobsProbe />);
    await settle();
    expect(screen.getByTestId("jobs")).toHaveTextContent("job-1:SUCCEEDED");
    expect(counts.jobs).toBe(1);

    // Well past the live cadence, nowhere near the idle one: a settled table is a record, not an
    // instrument, and must not be polled every four seconds.
    await settle(LIVE_POLL_MS * 4);
    expect(counts.jobs).toBe(1);

    await settle(IDLE_POLL_MS);
    expect(screen.getByTestId("jobs")).toHaveTextContent("job-1:PENDING");
  });
});

describe("a hidden tab is not polled", () => {
  it("stops while the tab is in the background and resumes when it comes back", async () => {
    const counts = serve({ jobs: [jobsPayload("RUNNING")] });
    renderLive(<JobsProbe />);
    await settle();
    expect(screen.getByTestId("jobs")).toHaveTextContent("job-1:RUNNING");
    expect(counts.jobs).toBe(1);

    act(() => setVisibility("hidden"));
    await settle(IDLE_POLL_MS * 2);
    // A running job and two idle periods elapsed: the ONLY reason nothing was fetched is the gate.
    expect(counts.jobs).toBe(1);

    act(() => setVisibility("visible"));
    await settle(LIVE_POLL_MS);
    expect(counts.jobs).toBeGreaterThan(1);
  });
});

describe("the catalog follows the ledger's cadence", () => {
  it("turns an artifact from amber to green while a verify runs, with no reload", async () => {
    serve({
      jobs: [jobsPayload("RUNNING")],
      artifacts: [artifactsPayload("UNOBSERVED"), artifactsPayload("VERIFIED")],
    });
    renderLive(<ArtifactsProbe />);
    await settle();
    expect(screen.getByTestId("artifacts")).toHaveTextContent("artifact-1:UNOBSERVED");

    await settle(LIVE_POLL_MS);
    // The state came from the server's second answer. Nothing here flipped it locally.
    expect(screen.getByTestId("artifacts")).toHaveTextContent("artifact-1:VERIFIED");
  });

  it("does not poll the catalog every few seconds when no job is running", async () => {
    const counts = serve({
      jobs: [jobsPayload("SUCCEEDED")],
      artifacts: [artifactsPayload("UNOBSERVED"), artifactsPayload("VERIFIED")],
    });
    renderLive(<ArtifactsProbe />);
    await settle();
    expect(screen.getByTestId("artifacts")).toHaveTextContent("artifact-1:UNOBSERVED");
    expect(counts.artifacts).toBe(1);

    await settle(LIVE_POLL_MS * 4);
    expect(counts.artifacts).toBe(1);
  });
});

describe("the screen says what it is doing", () => {
  it("states the cadence it is actually running at", () => {
    render(
      <I18nProvider>
        <LiveIndicator intervalMs={LIVE_POLL_MS} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("live-indicator")).toHaveTextContent(`every ${LIVE_POLL_MS / 1000}s`);
  });

  it("says it is paused rather than pretending to be live", () => {
    render(
      <I18nProvider>
        <LiveIndicator intervalMs={false} />
      </I18nProvider>,
    );
    const indicator = screen.getByTestId("live-indicator");
    expect(indicator).toHaveAttribute("data-live", "paused");
    expect(indicator).toHaveTextContent(/paused/i);
  });
});
