// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { DumpScope, TargetFacts } from "../descriptor.js";

export interface ProbeConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  // TLS is required by default; `false` is an explicit opt-out on the target, never a silent
  // fallback.
  readonly tls: boolean;
  // Mandatory: an unreachable target must never hang the job indefinitely.
  readonly connectTimeoutMs: number;
}

export interface DatabaseSize {
  readonly name: string;
  readonly sizeBytes: number;
}

export interface ProbeResult {
  readonly serverVersionNum: number;
  readonly databases: DatabaseSize[];
  readonly scope: DumpScope;
  readonly facts: TargetFacts;
}

// Normalizes a "major.minor.patch" version string to a comparable integer
// (major*10000 + minor*100 + patch), matching @schrodump/core's serverVersionNum encoding.
export function versionToNum(version: string): number {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return 0;
  return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
}
