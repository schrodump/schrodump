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
