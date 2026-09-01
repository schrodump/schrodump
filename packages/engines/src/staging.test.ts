// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { buildArchiveStaging, buildExtractStaging } from "./staging.js";

const IMAGE = "postgres:16-alpine";

describe("buildArchiveStaging", () => {
  it("streams the staging directory to stdout as a tar", () => {
    const d = buildArchiveStaging({ image: IMAGE, stagingPath: "/scratch/job-1" });
    expect(d.image).toBe(IMAGE);
    expect(d.outputKind).toBe("stdout");
    // -C then "." so the archive holds the directory's CONTENTS at its root, with no absolute paths
    // and no leading component to strip on the way back.
    expect(d.command).toEqual(["tar", "-cf", "-", "-C", "/scratch/job-1", "."]);
  });

  it("carries no environment, because it has no credential to carry", () => {
    // The archive step touches an already-written directory. Handing it the target's env would
    // widen where credentials travel for no reason.
    expect(buildArchiveStaging({ image: IMAGE, stagingPath: "/s" }).env).toEqual({});
  });
});

describe("buildExtractStaging", () => {
  it("extracts the archive into the target directory", () => {
    const d = buildExtractStaging({
      image: IMAGE,
      sourcePath: "/scratch/job-1.tar",
      targetPath: "/scratch/job-1-extracted",
    });
    expect(d.image).toBe(IMAGE);
    expect(d.outputKind).toBe("directory");
    expect(d.command).toEqual([
      "tar",
      "-xf",
      "/scratch/job-1.tar",
      "-C",
      "/scratch/job-1-extracted",
    ]);
  });

  it("carries no environment", () => {
    expect(buildExtractStaging({ image: IMAGE, sourcePath: "/a", targetPath: "/b" }).env).toEqual(
      {},
    );
  });
});
