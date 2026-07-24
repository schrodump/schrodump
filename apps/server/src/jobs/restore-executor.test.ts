// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactBelongsToOrg,
  createIdentityFile,
  globalsKeyFor,
  planRestoreSteps,
  restoreParamsOf,
  restoreScopeOf,
} from "./restore-executor.js";

describe("restoreParamsOf", () => {
  it("reads a valid RESTORE job's params", () => {
    const p = restoreParamsOf({ target: "DATABASE", confirmExistingDatabase: true, triggeredByUserId: "u1" });
    expect(p).toEqual({ target: "DATABASE", confirmExistingDatabase: true, triggeredByUserId: "u1" });
  });

  it("throws on missing/garbage params (a RESTORE job must carry them)", () => {
    expect(() => restoreParamsOf(null)).toThrow();
    expect(() => restoreParamsOf({ target: "NOPE" })).toThrow();
    // A blank user id is not a valid trigger — never audit a restore to nobody.
    expect(() => restoreParamsOf({ target: "DATABASE", confirmExistingDatabase: false, triggeredByUserId: "" })).toThrow();
  });
});

describe("artifactBelongsToOrg", () => {
  it("is true only when the artifact's org matches the job's org", () => {
    expect(artifactBelongsToOrg("org-a", "org-a")).toBe(true);
    expect(artifactBelongsToOrg("org-a", "org-b")).toBe(false);
  });
});

describe("restoreScopeOf", () => {
  it("parses a full scope and defaults missing arrays to empty", () => {
    expect(restoreScopeOf({ databases: ["app"], schemas: ["public"], collections: [] })).toEqual({
      databases: ["app"],
      schemas: ["public"],
      collections: [],
    });
    // A legitimately unscoped target (full instance) is valid, not a failure.
    expect(restoreScopeOf({})).toEqual({ databases: [], schemas: [], collections: [] });
  });

  it("fails LOUD on a malformed scope instead of degrading to empty", () => {
    expect(() => restoreScopeOf(null)).toThrow();
    expect(() => restoreScopeOf({ databases: "app" })).toThrow();
    expect(() => restoreScopeOf({ databases: [1, 2] })).toThrow();
  });
});

describe("globalsKeyFor", () => {
  it("derives the sibling globals.bin key for postgres", () => {
    expect(globalsKeyFor("postgres", 160002, "backups/org1/job1/artifact.bin")).toBe(
      "backups/org1/job1/globals.bin",
    );
  });

  it("is null for engines that do not need a separate globals dump", () => {
    expect(globalsKeyFor("mysql", 80036, "backups/org1/job1/artifact.bin")).toBeNull();
    expect(globalsKeyFor("mariadb", 110402, "backups/org1/job1/artifact.bin")).toBeNull();
    expect(globalsKeyFor("mongodb", 80004, "backups/org1/job1/artifact.bin")).toBeNull();
  });
});

describe("planRestoreSteps", () => {
  const descriptor = (label: string): ExecutionDescriptor => ({
    image: label,
    command: [label],
    env: {},
    outputKind: "stdout",
  });

  it("restores globals BEFORE the per-database artifact for postgres", () => {
    const steps = planRestoreSteps(
      "k/artifact.bin",
      () => descriptor("restore"),
      "k/globals.bin",
      () => descriptor("globals"),
    );
    expect(steps.map((s) => s.key)).toEqual(["k/globals.bin", "k/artifact.bin"]);
    expect(steps[0]?.descriptor.image).toBe("globals");
    expect(steps[1]?.descriptor.image).toBe("restore");
  });

  it("is a single step when there is no globals object", () => {
    const steps = planRestoreSteps("k/artifact.bin", () => descriptor("restore"), null, () => null);
    expect(steps.map((s) => s.key)).toEqual(["k/artifact.bin"]);
  });
});

describe("createIdentityFile", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it("writes the identity 0600 and removes it on cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restore-identity-test-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const identity = "AGE-SECRET-KEY-1EXAMPLEIDENTITY";
    const file = await createIdentityFile(dir, "job-1", identity);

    // Restore passes a reserved scratch directory; the identity must land INSIDE it.
    expect(file.path.startsWith(dir)).toBe(true);
    const info = await stat(file.path);
    // Only the owner may read the operational identity.
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(file.path, "utf8")).toBe(identity);

    await file.cleanup();
    await expect(stat(file.path)).rejects.toThrow();
  });

  it("cleanup is idempotent (safe to call in finally after an early failure)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restore-identity-test-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    // Force a restrictive umask-independent baseline for the assertion above.
    await chmod(dir, 0o700);

    const file = await createIdentityFile(dir, "job-2", "AGE-SECRET-KEY-1X");
    await file.cleanup();
    await expect(file.cleanup()).resolves.toBeUndefined();
  });
});
