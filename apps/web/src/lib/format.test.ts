// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  dayGroupOf,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatServerVersion,
  formatTime,
} from "./format";

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

describe("formatDateTime / formatTime", () => {
  it("returns empty string for an unparseable value, so the caller renders the absence", () => {
    expect(formatDateTime("not-a-date")).toBe("");
    expect(formatDateTime("")).toBe("");
    expect(formatTime("nope")).toBe("");
  });

  it("renders a real ISO timestamp in the viewer's locale/zone (non-empty, not the raw string)", () => {
    // The bug: rows sliced the ISO string (UTC), so a São Paulo operator saw a job's UTC time.
    // We assert it does NOT echo the raw ISO and is non-empty — the exact text is the viewer's
    // locale/zone and must not be pinned here.
    const out = formatDateTime("2026-01-02T03:04:05.000Z");
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("T03:04:05");
    expect(formatTime("2026-01-02T03:04:05.000Z").length).toBeGreaterThan(0);
  });
});

describe("formatDuration", () => {
  it("returns empty string for negative or non-finite input", () => {
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });

  it("scales seconds → minutes → hours, dropping a zero remainder", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(92_000)).toBe("1m 32s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_660_000)).toBe("1h 1m");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-01-10T00:00:00.000Z");

  it("returns empty string for an unparseable value", () => {
    expect(formatRelative("nope", now)).toBe("");
  });

  it("picks the unit by magnitude — the selection is the logic, the wording is the locale's", () => {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    // 3 days before `now` lands in the day division as -3; 90 minutes lands in the hour division.
    expect(formatRelative("2026-01-07T00:00:00.000Z", now)).toBe(rtf.format(-3, "day"));
    expect(formatRelative("2026-01-09T22:30:00.000Z", now)).toBe(rtf.format(-1, "hour"));
    // A few seconds ago stays in the second division rather than rounding up to a minute.
    expect(formatRelative("2026-01-09T23:59:55.000Z", now)).toBe(rtf.format(-5, "second"));
  });
});

describe("dayGroupOf", () => {
  // Built with local constructors so the expectation holds in any timezone the test runs in.
  const now = new Date(2026, 8, 9, 15, 0, 0); // 9 Sep 2026, 15:00 local
  const at = (y: number, m: number, d: number, h: number): string => new Date(y, m, d, h).toISOString();

  it("names today and yesterday by the viewer's day boundary, not the ISO string's", () => {
    expect(dayGroupOf(at(2026, 8, 9, 0), now)).toEqual({ key: "2026-09-09", label: "today" });
    expect(dayGroupOf(at(2026, 8, 8, 23), now)).toEqual({ key: "2026-09-08", label: "yesterday" });
  });

  it("leaves older days to the date, with a stable key for grouping", () => {
    expect(dayGroupOf(at(2026, 8, 6, 3), now)).toEqual({ key: "2026-09-06", label: null });
    expect(dayGroupOf(at(2026, 8, 6, 22), now).key).toBe("2026-09-06");
  });

  it("groups an unparseable value under an empty key rather than dropping it", () => {
    expect(dayGroupOf("not a date", now)).toEqual({ key: "", label: null });
  });
});
