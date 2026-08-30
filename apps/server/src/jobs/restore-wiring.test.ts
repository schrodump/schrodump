// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { createRestorePorts, type RestoreWiringDeps } from "./restore-wiring.js";

function deps(over: Partial<Awaited<ReturnType<RestoreWiringDeps["loadArtifactRow"]>>> = {}): RestoreWiringDeps {
  const unused = (): never => {
    throw new Error("not used in this test");
  };
  return {
    loadArtifactRow: () =>
      Promise.resolve({
        manifestKeyIds: ["op"],
        engine: "mongodb" as const,
        executionMode: "STREAM" as const,
        serverVersionNum: 80004,
        destinationName: "prod-s3",
        ...over,
      }),
    availableKeys: unused,
    targetHasExistingData: unused,
    audit: unused,
    setJobState: unused,
    runRestore: unused,
  };
}

// The hop that decides whether the shutdown-era consistency caveat fires at all. The domain tests
// `sourceHasOplog === undefined`, and Prisma hands back `null` for an unrecorded column — so a
// mapping that leaks the null through would silently stop degrading old artifacts, defeating the
// feature without failing anything else.
describe("createRestorePorts — oplog provenance mapping", () => {
  it("carries a recorded true through to the domain", async () => {
    const artifact = await createRestorePorts(deps({ sourceHasOplog: true })).loadArtifact();
    expect(artifact.sourceHasOplog).toBe(true);
  });

  it("carries a recorded false through, distinctly from unknown", async () => {
    const artifact = await createRestorePorts(deps({ sourceHasOplog: false })).loadArtifact();
    expect(artifact.sourceHasOplog).toBe(false);
  });

  it("reports an unrecorded column as undefined, which is what the domain tests for", async () => {
    const artifact = await createRestorePorts(deps()).loadArtifact();
    expect(artifact.sourceHasOplog).toBeUndefined();
    expect("sourceHasOplog" in artifact).toBe(false);
  });
});
