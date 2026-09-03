// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { afterEach, describe, expect, it, vi } from "vitest";
import { producerVersion, serverVersion } from "./version.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serverVersion", () => {
  it("reports the version the image was built with", () => {
    vi.stubEnv("SCHRODUMP_VERSION", "0.1.0-rc.1");
    expect(serverVersion()).toBe("0.1.0-rc.1");
  });

  it("says dev rather than inventing a release number when nothing stamped it", () => {
    vi.stubEnv("SCHRODUMP_VERSION", undefined);
    expect(serverVersion()).toBe("0.0.0-dev");
  });

  it("treats a blank stamp as no stamp — an unsubstituted build arg is not a version", () => {
    vi.stubEnv("SCHRODUMP_VERSION", "   ");
    expect(serverVersion()).toBe("0.0.0-dev");
  });
});

describe("producerVersion", () => {
  it("names the build that wrote an artifact, which is what Manifest.toolVersion is for", () => {
    // It read "schrodump-server/0.0.0" for every build ever shipped: the one field that answers
    // "what produced this backup" answered the same thing regardless of what produced it.
    vi.stubEnv("SCHRODUMP_VERSION", "0.1.0-rc.1");
    expect(producerVersion()).toBe("schrodump-server/0.1.0-rc.1");
  });
});
