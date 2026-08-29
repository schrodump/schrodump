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
  id: "j1", organizationId: "o1", kind: "BACKUP", policyId: "p1", artifactId: null, correlationId: "backup:p1", restoreParams: null,
};
const verifyJob: ClaimedJob = {
  id: "j2", organizationId: "o1", kind: "VERIFY", policyId: null, artifactId: "a1", correlationId: "verify:a1", restoreParams: null,
};

function makeDeps(over: {
  jobs?: (ClaimedJob | null)[];
  backup?: JobExecutor["runBackup"];
  verify?: JobExecutor["runVerify"];
  restore?: JobExecutor["runRestore"];
  enqueueVerify?: WorkerStore["enqueueVerify"];
  signal?: AbortSignal;
}): {
  deps: WorkerDeps;
  store: { enqueueVerify: ReturnType<typeof vi.fn>; failJob: ReturnType<typeof vi.fn> };
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
  const queue = [...(over.jobs ?? [])];
  const enqueueVerify = vi.fn(over.enqueueVerify ?? (() => Promise.resolve("v1")));
  const failJob = vi.fn(() => Promise.resolve());
  const store: WorkerStore = {
    claimNextJob: () => Promise.resolve(queue.length > 0 ? (queue.shift() as ClaimedJob | null) : null),
    failJob,
    enqueueVerify,
  };
  const executor: JobExecutor = {
    runBackup: over.backup ?? (() => Promise.resolve({ ok: true, artifactId: "a1", verifyLevel: "CHECKSUM" })),
    runVerify: over.verify ?? (() => Promise.resolve()),
    runRestore: over.restore ?? (() => Promise.resolve()),
  };
  const log = { info: vi.fn(), error: vi.fn() };
  return {
    deps: {
      store,
      executor,
      log,
      sanitizeReason: () => "sanitized",
      ...(over.signal !== undefined ? { signal: over.signal } : {}),
    },
    store: { enqueueVerify, failJob },
    log,
  };
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

  it("does not FAIL a SUCCEEDED backup when the follow-up verify enqueue throws — only logs", async () => {
    const { deps, store, log } = makeDeps({
      jobs: [backupJob],
      enqueueVerify: () => Promise.reject(new Error("insert into BackupJob failed")),
    });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.enqueueVerify).toHaveBeenCalledWith("o1", "a1");
    expect(store.failJob).not.toHaveBeenCalled(); // the backup already succeeded via its ports
    expect(log.error).toHaveBeenCalledWith(
      { jobId: "j1", reason: "sanitized" },
      "backup ok but verify enqueue failed",
    );
  });

  it("runs a VERIFY job and chains nothing", async () => {
    const runVerify = vi.fn(() => Promise.resolve());
    const { deps, store } = makeDeps({ jobs: [verifyJob], verify: runVerify });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(runVerify).toHaveBeenCalledOnce();
    expect(store.enqueueVerify).not.toHaveBeenCalled();
  });

  it("dispatches a RESTORE job to runRestore and chains nothing", async () => {
    const runRestore = vi.fn(() => Promise.resolve());
    const restoreJob: ClaimedJob = {
      id: "j4", organizationId: "o1", kind: "RESTORE", policyId: null, artifactId: "a1", correlationId: "restore:a1",
      restoreParams: { target: "DATABASE", confirmExistingDatabase: false, triggeredByUserId: "u1" },
    };
    const { deps, store } = makeDeps({ jobs: [restoreJob], restore: runRestore });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(runRestore).toHaveBeenCalledOnce();
    expect(store.enqueueVerify).not.toHaveBeenCalled();
  });

  it("catches runVerify throw and fails the job with a sanitized reason", async () => {
    const runVerify = vi.fn(() => Promise.reject(new Error("database connection failed")));
    const { deps, store } = makeDeps({ jobs: [verifyJob], verify: runVerify });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.failJob).toHaveBeenCalledWith("j2", "sanitized");
  });

  it("fails an unsupported kind", async () => {
    const unknownJob: ClaimedJob = { ...verifyJob, id: "j3", kind: "UNKNOWN" as unknown as ClaimedJob["kind"] };
    const { deps, store } = makeDeps({ jobs: [unknownJob] });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.failJob).toHaveBeenCalledWith("j3", expect.stringContaining("UNKNOWN"));
  });

  it("catches a thrown executor and fails the job with a sanitized reason", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () => Promise.reject(new Error("password=hunter2 leaked")),
    });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.failJob).toHaveBeenCalledWith("j1", "sanitized");
  });

  it("claims nothing and reports idle once the shutdown signal is aborted", async () => {
    const { deps, store } = makeDeps({ jobs: [backupJob], signal: AbortSignal.abort() });
    expect(await runWorkerOnce(deps)).toBe("idle");
    expect(store.failJob).not.toHaveBeenCalled();
  });

  it("hands the shutdown signal to the executor", async () => {
    const controller = new AbortController();
    const backup = vi.fn(() =>
      Promise.resolve({ ok: true, artifactId: "a1", verifyLevel: "NONE" as const }),
    );
    const { deps } = makeDeps({ jobs: [backupJob], backup, signal: controller.signal });
    await runWorkerOnce(deps);
    expect(backup).toHaveBeenCalledWith(backupJob, controller.signal);
  });
});

describe("drainQueue", () => {
  it("drains every ready job then stops, returning the count", async () => {
    const { deps } = makeDeps({ jobs: [backupJob, verifyJob, backupJob] });
    expect(await drainQueue(deps)).toBe(3);
  });
});

describe("drainQueue under shutdown", () => {
  it("stops claiming the moment the signal aborts, instead of starting another dump", async () => {
    const controller = new AbortController();
    const backup = vi.fn(() => {
      controller.abort(); // the shutdown lands while this job is running
      return Promise.resolve({ ok: true, artifactId: null, verifyLevel: "NONE" as const });
    });
    const { deps } = makeDeps({
      jobs: [backupJob, backupJob, backupJob],
      backup,
      signal: controller.signal,
    });
    expect(await drainQueue(deps)).toBe(1);
    expect(backup).toHaveBeenCalledTimes(1);
  });
});
