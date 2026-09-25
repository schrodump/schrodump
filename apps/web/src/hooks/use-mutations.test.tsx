// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// A mutation has to invalidate what it actually changed, and the gaps here were all visible on
// screen: a verify wrote a job AND decided an artifact, but only ["jobs"] was invalidated, so the
// catalog stayed amber; a restore invalidated nothing at all; and the two recorded checks — the
// canary and the probe — left a green "Canary passed" panel sitting directly above a row still
// reading "never checked", with the guided setup's step still open under both.
//
// Every assertion waits for `isSuccess`, a data-dependent signal: the invalidation happens in
// onSuccess, so asserting before it would be asserting on nothing.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useCanary,
  useDeleteArtifact,
  useTestConnection,
  useTriggerBackup,
  useTriggerRestore,
  useTriggerVerify,
} from "@/hooks/use-mutations";

function stubOk(body: unknown = { jobId: "job-42" }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })),
  );
}

// The spy calls through, so the real invalidation still happens — it only records which keys were
// asked for. A mock that swallowed the call would prove the hook said the words, not that the cache
// heard them.
function setup<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(hook, { wrapper });
  const invalidated = () => spy.mock.calls.map((call) => (call[0]?.queryKey ?? [])[0]);
  return { result, invalidated };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a run that touches an artifact invalidates the artifact, not only the ledger", () => {
  it("backup: jobs and artifacts", async () => {
    stubOk();
    const { result, invalidated } = setup(() => useTriggerBackup());
    result.current.mutate("policy-1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidated()).toEqual(expect.arrayContaining(["jobs", "artifacts"]));
  });

  it("verify: jobs and artifacts — this is the one that left the catalog amber", async () => {
    stubOk();
    const { result, invalidated } = setup(() => useTriggerVerify());
    result.current.mutate("artifact-1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidated()).toEqual(expect.arrayContaining(["jobs", "artifacts"]));
  });

  it("restore: jobs and artifacts — it used to invalidate nothing whatsoever", async () => {
    stubOk();
    const { result, invalidated } = setup(() => useTriggerRestore());
    result.current.mutate({ artifactId: "artifact-1", target: "DATABASE", confirmExistingDatabase: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidated()).toEqual(expect.arrayContaining(["jobs", "artifacts"]));
  });

  it("delete: artifacts and jobs, because every ledger row carries its artifact's verdict", async () => {
    stubOk(null);
    const { result, invalidated } = setup(() => useDeleteArtifact());
    result.current.mutate({ artifactId: "artifact-1", acknowledgeVerified: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidated()).toEqual(expect.arrayContaining(["artifacts", "jobs"]));
  });
});

describe("a recorded check invalidates the row that records it", () => {
  it("canary: destinations, which is what both the row and the guided step read", async () => {
    stubOk({ ok: true, failedOperation: null });
    const { result, invalidated } = setup(() => useCanary());
    result.current.mutate("destination-1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidated()).toContain("destinations");
  });

  it("test-connection: targets, likewise", async () => {
    stubOk({ ok: true, serverVersionNum: 160_004, failure: null, driverCode: null, databases: [] });
    const { result, invalidated } = setup(() => useTestConnection());
    result.current.mutate("target-1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidated()).toContain("targets");
  });
});
