// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type {
  ArtifactState,
  CompressionAlgorithm,
  EngineKind,
  ExecutionMode,
  JobKind,
  JobState,
  SealMode,
  VerifyLevel,
} from "@/lib/domain";

export type { JobKind, JobState } from "@/lib/domain";

export interface Artifact {
  id: string;
  jobId: string;
  destinationId: string;
  state: ArtifactState;
  bucketKey: string;
  manifestKey: string;
  engine: EngineKind;
  executionMode: ExecutionMode;
  serverVersionNum: number;
  sizeRawBytes: number;
  sizeCompressedBytes: number;
  checksumAlgorithm: string;
  checksum: string;
  compression: CompressionAlgorithm;
  keyIds: string[];
  dependsOn: string[];
  createdAt: string;
}

export interface Job {
  id: string;
  policyId: string | null;
  kind: JobKind;
  state: JobState;
  correlationId: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  stderr: string | null;
  reason: string | null;
  createdAt: string;
}

export interface Target {
  id: string;
  name: string;
  engine: EngineKind;
  host: string;
  port: number;
  username: string;
  tls: boolean;
  // What the target is scoped to back up. The server has always returned it (toPublicTarget); the
  // web simply never declared it, so nothing could read it back — which is what an edit form needs
  // to show the databases already configured instead of silently clearing them.
  scope: { databases: string[]; schemas: string[]; collections: string[] };
  createdAt: string;
}

export interface Destination {
  id: string;
  name: string;
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  sealMode: SealMode;
}

export interface Policy {
  id: string;
  name: string;
  targetId: string;
  destinationId: string;
  cron: string;
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  minAgeBeforeDeleteMs: number;
  verifyLevel: VerifyLevel;
  executionMode: ExecutionMode;
  parallelism: number;
  compression: CompressionAlgorithm;
  enabled: boolean;
}

export function countByState(artifacts: Artifact[]): Record<ArtifactState, number> {
  const counts: Record<ArtifactState, number> = { VERIFIED: 0, UNOBSERVED: 0, FAILED: 0 };
  for (const artifact of artifacts) counts[artifact.state] += 1;
  return counts;
}
