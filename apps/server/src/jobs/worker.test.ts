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
  id: "j1",
  organizationId: "o1",
  kind: "BACKUP",
  policyId: "p1",
  artifactId: null,
  correlationId: "backup:p1",
  restoreParams: null,
};
const verifyJob: ClaimedJob = {
  id: "j2",
  organizationId: "o1",
  kind: "VERIFY",
  policyId: null,
  artifactId: "a1",
  correlationId: "verify:a1",
  restoreParams: null,
};

const retentionJob: ClaimedJob = {
  id: "j3",
  organizationId: "o1",
  kind: "RETENTION",
  policyId: "p1",
  artifactId: null,
  correlationId: "retention:p1",
  restoreParams: null,
};

function makeDeps(over: {
  jobs?: (ClaimedJob | null)[];
  backup?: JobExecutor["runBackup"];
  verify?: JobExecutor["runVerify"];
  restore?: JobExecutor["runRestore"];
  retention?: JobExecutor["runRetention"];
  enqueueVerify?: WorkerStore["enqueueVerify"];
  enqueueRetention?: WorkerStore["enqueueRetention"];
}): {
  deps: WorkerDeps;
  store: {
    enqueueVerify: ReturnType<typeof vi.fn>;
    enqueueRetention: ReturnType<typeof vi.fn>;
    failJob: ReturnType<typeof vi.fn>;
  };
  executor: { runRetention: ReturnType<typeof vi.fn> };
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
  const queue = [...(over.jobs ?? [])];
  const enqueueVerify = vi.fn(over.enqueueVerify ?? (() => Promise.resolve("v1")));
  const enqueueRetention = vi.fn(over.enqueueRetention ?? (() => Promise.resolve("r1")));
  const failJob = vi.fn(() => Promise.resolve());
  const store: WorkerStore = {
    claimNextJob: () =>
      Promise.resolve(queue.length > 0 ? (queue.shift() as ClaimedJob | null) : null),
    failJob,
    enqueueVerify,
    enqueueRetention,
  };
  const runRetention = vi.fn(over.retention ?? (() => Promise.resolve()));
  const executor: JobExecutor = {
    runBackup:
      over.backup ??
      (() =>
        Promise.resolve({
          ok: true,
          artifactId: "a1",
          verifyLevel: "CHECKSUM",
          retentionConfigured: true,
        })),
    runVerify: over.verify ?? (() => Promise.resolve()),
    runRestore: over.restore ?? (() => Promise.resolve()),
    runRetention,
  };
  const log = { info: vi.fn(), error: vi.fn() };
  return {
    deps: { store, executor, log, sanitizeReason: () => "sanitized" },
    store: { enqueueVerify, enqueueRetention, failJob },
    executor: { runRetention },
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

  it("dispatches a RETENTION job to the executor", async () => {
    const { deps, executor } = makeDeps({ jobs: [retentionJob] });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(executor.runRetention).toHaveBeenCalledWith(retentionJob);
  });

  it("chains a RETENTION after a successful backup", async () => {
    const { deps, store } = makeDeps({ jobs: [backupJob] });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.enqueueRetention).toHaveBeenCalledWith("o1", "p1");
  });

  // The safety property that makes chaining the right trigger: pruning old copies is only ever
  // safe just after a new one landed. A failed backup must never cost you an old artifact.
  it("never chains a RETENTION after a FAILED backup", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () =>
        Promise.resolve({
          ok: false,
          artifactId: null,
          verifyLevel: "CHECKSUM",
          retentionConfigured: true,
        }),
    });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.enqueueRetention).not.toHaveBeenCalled();
  });

  // A policy that keeps everything forever is a legitimate configuration, not an error. Enqueuing
  // a job per backup just to report "nothing to do" would train the operator to ignore the job
  // list — which is the one place the FAILED cases have to be visible.
  it("never chains a RETENTION when the policy configures no retention at all", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () =>
        Promise.resolve({
          ok: true,
          artifactId: "a1",
          verifyLevel: "CHECKSUM",
          retentionConfigured: false,
        }),
    });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.enqueueRetention).not.toHaveBeenCalled();
    expect(store.enqueueVerify).toHaveBeenCalled(); // verify still chains — the two are independent
  });

  it("never chains a RETENTION after a backup that has no policy (manual / self-backup)", async () => {
    const { deps, store } = makeDeps({ jobs: [{ ...backupJob, policyId: null }] });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.enqueueRetention).not.toHaveBeenCalled();
  });

  // Same rule the verify chain already follows: the backup is already SUCCEEDED and genuinely
  // succeeded. A follow-up that fails to enqueue is logged, never retroactively fatal.
  it("does not fail a successful backup when the retention enqueue throws", async () => {
    const { deps, store, log } = makeDeps({
      jobs: [backupJob],
      enqueueRetention: () => Promise.reject(new Error("db down")),
    });
    expect(await runWorkerOnce(deps)).toBe("ran");
    expect(store.failJob).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it("does not chain a VERIFY when the policy's verify level is NONE", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () =>
        Promise.resolve({
          ok: true,
          artifactId: "a1",
          verifyLevel: "NONE",
          retentionConfigured: true,
        }),
    });
    await runWorkerOnce(deps);
    expect(store.enqueueVerify).not.toHaveBeenCalled();
  });

  it("does not chain when the backup failed", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () =>
        Promise.resolve({
          ok: false,
          artifactId: null,
          verifyLevel: "CHECKSUM",
          retentionConfigured: true,
        }),
    });
    await runWorkerOnce(deps);
    expect(store.enqueueVerify).not.toHaveBeenCalled();
    expect(store.failJob).not.toHaveBeenCalled(); // the pure job already set FAILED via its ports
  });

  it("does not chain when backup.ok is false even if artifactId is non-null", async () => {
    const { deps, store } = makeDeps({
      jobs: [backupJob],
      backup: () =>
        Promise.resolve({
          ok: false,
          artifactId: "a1",
          verifyLevel: "CHECKSUM",
          retentionConfigured: true,
        }),
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
      id: "j4",
      organizationId: "o1",
      kind: "RESTORE",
      policyId: null,
      artifactId: "a1",
      correlationId: "restore:a1",
      restoreParams: {
        target: "DATABASE",
        confirmExistingDatabase: false,
        triggeredByUserId: "u1",
      },
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
    const unknownJob: ClaimedJob = {
      ...verifyJob,
      id: "j3",
      kind: "UNKNOWN" as unknown as ClaimedJob["kind"],
    };
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
});

describe("drainQueue", () => {
  it("drains every ready job then stops, returning the count", async () => {
    const { deps } = makeDeps({ jobs: [backupJob, verifyJob, backupJob] });
    expect(await drainQueue(deps)).toBe(3);
  });
});
