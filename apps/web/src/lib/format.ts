// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

// Locale-independent byte formatting for artifact sizes. Kept pure so it is trivially testable.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${UNITS[exp]}`;
}

// Reverses the server's serverVersionNum encoding (major*10000 + minor*100 + patch) back to a
// human "7.0.15". The number is a comparison key on the wire, never something to show as-is.
export function formatServerVersion(versionNum: number): string {
  if (!Number.isInteger(versionNum) || versionNum <= 0) return "?";
  const major = Math.floor(versionNum / 10000);
  const minor = Math.floor((versionNum % 10000) / 100);
  const patch = versionNum % 100;
  return `${major}.${minor}.${patch}`;
}

// Timestamps travel as UTC ISO strings; the operator reads them where they are. Rendering with Intl
// at the browser's resolved locale and timezone means a São Paulo operator does not silently add
// three hours in their head — the row said 05:00 for a job that ran at 02:00 their time, which is
// exactly the kind of quiet mismatch that makes a person distrust the whole screen. An unparseable
// or empty value returns "" so the caller decides what absence looks like (a dash, a placeholder).

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
}

// Successively larger units, each expressed in the previous one. The loop divides the elapsed time
// down until it lands in a unit whose magnitude is below the next threshold — so 90 minutes reads as
// "an hour ago", not "90 minutes ago". `numeric: "auto"` gives "yesterday"/"just now" where the
// locale has a word for it. Freshness at a glance: "verified 3 days ago" is the question the
// dashboard is really asking, and an absolute timestamp buries it.
const DIVISIONS: { readonly amount: number; readonly unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

// A short, locale-independent elapsed time for how long a job ran or waited: "45s", "1m 32s",
// "2h 5m". Compact on purpose — it sits inline on a dense job row, where an operator scans it, not
// reads it. Negative or non-finite input returns "" (the caller renders the absence).
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let duration = (date.getTime() - now.getTime()) / 1000; // seconds; negative is the past
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) return rtf.format(Math.round(duration), division.unit);
    duration /= division.amount;
  }
  return rtf.format(Math.round(duration), "year");
}
