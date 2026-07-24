// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import { formatBytes, formatServerVersion } from "./format";

describe("formatBytes", () => {
  it("formats zero and non-positive input as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("scales to the right unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
  });
});

describe("formatServerVersion", () => {
  it("reverses the server's numeric encoding", () => {
    // The bug this fixes: 70015 was shown to the user verbatim instead of 7.0.15.
    expect(formatServerVersion(70015)).toBe("7.0.15");
    expect(formatServerVersion(160004)).toBe("16.0.4");
    expect(formatServerVersion(80036)).toBe("8.0.36");
    expect(formatServerVersion(130000)).toBe("13.0.0");
  });

  it("returns a placeholder for a value that is not a real version", () => {
    expect(formatServerVersion(0)).toBe("?");
    expect(formatServerVersion(-1)).toBe("?");
    expect(formatServerVersion(1.5)).toBe("?");
  });
});
