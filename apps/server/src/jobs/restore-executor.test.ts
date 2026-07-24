// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { ExecutionDescriptor } from "@schrodump/core/execution";
import { describe, expect, it } from "vitest";
import {
  artifactBelongsToOrg,
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
  // A restore descriptor built for a given mount path; the command carries a label (to assert
  // ordering) AND the sourcePath (to assert each step is built with the path it stages the dump at).
  const descriptor = (label: string, sourcePath: string): ExecutionDescriptor => ({
    image: label,
    command: [label, sourcePath],
    env: {},
    outputKind: "directory",
  });

  it("restores globals BEFORE the per-database artifact, each built with its sourcePath", () => {
    const steps = planRestoreSteps(
      "k/artifact.bin",
      (sourcePath) => descriptor("restore", sourcePath),
      "k/globals.bin",
      (sourcePath) => descriptor("globals", sourcePath),
    );
    expect(steps.map((s) => s.key)).toEqual(["k/globals.bin", "k/artifact.bin"]);

    // The builders are deferred: each step wires the mount path THROUGH to its descriptor.
    const globals = steps[0]?.buildDescriptor("/stage/globals");
    expect(globals?.image).toBe("globals");
    expect(globals?.command).toEqual(["globals", "/stage/globals"]);

    const artifact = steps[1]?.buildDescriptor("/stage/artifact");
    expect(artifact?.image).toBe("restore");
    expect(artifact?.command).toEqual(["restore", "/stage/artifact"]);
  });

  it("is a single step when there is no globals object", () => {
    const steps = planRestoreSteps(
      "k/artifact.bin",
      (sourcePath) => descriptor("restore", sourcePath),
      null,
      () => null,
    );
    expect(steps.map((s) => s.key)).toEqual(["k/artifact.bin"]);
    expect(steps[0]?.buildDescriptor("/stage/x").command).toEqual(["restore", "/stage/x"]);
  });
});
