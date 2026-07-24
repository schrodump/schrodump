// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it, vi } from "vitest";
import {
  drainQueue,
  runWorkerOnce,
  type ClaimedJob,
  type JobExecutor,
  type WorkerDeps,
  type WorkerStore,
} from "./worker.js";

const backupJob: ClaimedJob = {
  id: "j1", organizationId: "o1", kind: "BACKUP", policyId: "p1", artifactId: null, correlationId: "backup:p1",
};
const verifyJob: ClaimedJob = {
  id: "j2", organizationId: "o1", kind: "VERIFY", policyId: null, artifactId: "a1", correlationId: "verify:a1",
};

function makeDeps(over: {
  jobs?: (ClaimedJob | null)[];
  backup?: JobExecutor["runBackup"];
  verify?: JobExecutor["runVerify"];
}): { deps: WorkerDeps; store: { enqueueVerify: ReturnType<typeof vi.fn>; failJob: ReturnType<typeof vi.fn> } } {
  const queue = [...(over.jobs ?? [])];
  const enqueueVerify = vi.fn(() => Promise.resolve("v1"));
  const failJob = vi.fn(() => Promise.resolve());
  const store: WorkerStore = {
    claimNextJob: () => Promise.resolve(queue.length > 0 ? (queue.shift() as ClaimedJob | null) : null),
    failJob,
    enqueueVerify,
  };
  const executor: JobExecutor = {
    runBackup: over.backup ?? (() => Promise.resolve({ ok: true, artifactId: "a1", verifyLevel: "CHECKSUM" })),
    runVerify: over.verify ?? (() => Promise.resolve()),
  };
  const log = { info: () => {}, error: () => {} };
  return { deps: { store, executor, log, sanitizeReason: () => "sanitized" }, store: { enqueueVerify, failJob } };
}

describe("runWorkerOnce", () => {
  it("returns idle and does nothing when the queue is empty", async () => {
    const { deps, store } = makeDeps({ jobs: [] });
    expect(await runWorkerOnce(deps)).toBe("idle");
    expect(store.failJob).not.toHaveBeenCalled();
  });

  it("chains a VERIFY after a successful backup whose policy verifies", async () => {
    const { deps, store } = makeDeps({ jobs: [backupJob] });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.enqueueVerify).toHaveBeenCalledWith("o1", "a1");
  });

  it("does not chain a VERIFY when the policy's verify level is NONE", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () => Promise.resolve({ ok: true, artifactId: "a1", verifyLevel: "NONE" }),
    });
    await runWorkerOnce(deps);
    expect(store.enqueueVerify).not.toHaveBeenCalled();
  });

  it("does not chain when the backup failed", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () => Promise.resolve({ ok: false, artifactId: null, verifyLevel: "CHECKSUM" }),
    });
    await runWorkerOnce(deps);
    expect(store.enqueueVerify).not.toHaveBeenCalled();
    expect(store.failJob).not.toHaveBeenCalled(); // the pure job already set FAILED via its ports
  });

  it("does not chain when backup.ok is false even if artifactId is non-null", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () => Promise.resolve({ ok: false, artifactId: "a1", verifyLevel: "CHECKSUM" }),
    });
    await runWorkerOnce(deps);
    expect(store.enqueueVerify).not.toHaveBeenCalled();
  });

  it("runs a VERIFY job and chains nothing", async () => {
    const runVerify = vi.fn(() => Promise.resolve());
    const { deps, store } = makeDeps({ jobs: [verifyJob], verify: runVerify });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(runVerify).toHaveBeenCalledOnce();
    expect(store.enqueueVerify).not.toHaveBeenCalled();
  });

  it("catches runVerify throw and fails the job with a sanitized reason", async () => {
    const runVerify = vi.fn(() => Promise.reject(new Error("database connection failed")));
    const { deps, store } = makeDeps({ jobs: [verifyJob], verify: runVerify });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.failJob).toHaveBeenCalledWith("j2", "sanitized");
  });

  it("fails an unsupported kind", async () => {
    const restore: ClaimedJob = { ...verifyJob, id: "j3", kind: "RESTORE", artifactId: null };
    const { deps, store } = makeDeps({ jobs: [restore] });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.failJob).toHaveBeenCalledWith("j3", expect.stringContaining("RESTORE"));
  });

  it("catches a thrown executor and fails the job with a sanitized reason", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () => Promise.reject(new Error("password=hunter2 leaked")),
    });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.failJob).toHaveBeenCalledWith("j1", "sanitized");
  });
});

describe("drainQueue", () => {
  it("drains every ready job then stops, returning the count", async () => {
    const { deps } = makeDeps({ jobs: [backupJob, verifyJob, backupJob] });
    expect(await drainQueue(deps)).toBe(3);
  });
});
