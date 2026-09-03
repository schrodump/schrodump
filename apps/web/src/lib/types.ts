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
  // Whether this archive carries an oplog, which is what makes a FULL_CLUSTER restore land every
  // collection on ONE instant. null means the engine has none — a different statement from false,
  // "a mongo dump that carries none", and the interface must not blur them.
  sourceHasOplog: boolean | null;
  // Whether this artifact's dump script carries more than one database. Only mysql/mariadb answer
  // it; null means never recorded, which is NOT the same as no — see canConfineRestore.
  dumpIsMultiDatabase: boolean | null;
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
  // The last operator-triggered connection probe. All three null means it has never run, which is
  // NOT the same as having run and been refused — the setup checklist only stops asking for one.
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastProbeFailure: string | null;
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
  // The last canary (put/get/delete against the bucket). null means never run.
  lastCanaryAt: string | null;
  lastCanaryOk: boolean | null;
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

// countByState used to live here, deriving the dashboard's counters from the fetched array. It is
// deliberately gone rather than left unused: the artifact list is now capped server-side, so any
// count derived from it would understate the unobserved total — the one number this product leads
// with. GET /artifacts returns `counts` computed over the whole table; use that.

// Mirrors the server's ChannelRecord minus the secrets, which the API never returns. lastFailure
// is present on purpose: a notifier nobody can tell is broken is worse than having none, so the
// interface has to be able to show it.
export type NotificationChannelKind = "WEBHOOK" | "SMTP";

export interface NotificationChannel {
  id: string;
  kind: NotificationChannelKind;
  url: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUsername: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  enabled: boolean;
  lastFailureAt: string | null;
  lastFailure: string | null;
}

// A dump of the deployment's own metadata database. Instance-scoped, so it has no organizationId
// in the DTO. `configured` on the envelope is what separates "never set up" from "set up and never
// ran" — an empty list alone cannot tell those apart.
export interface SelfBackup {
  id: string;
  state: "RUNNING" | "SUCCEEDED" | "FAILED";
  destinationId: string;
  bucketKey: string | null;
  sizeBytes: number | null;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SelfBackupList {
  configured: boolean;
  items: SelfBackup[];
}

// Both list endpoints are capped server-side. `total` is what the row count actually is, so the UI
// can say it is showing the newest N of M instead of implying it showed everything.
export interface JobList {
  items: Job[];
  total: number;
}

// `counts` is computed across the whole table, NOT from `items`. The dashboard's primary number is
// "N unobserved backups"; deriving it from a truncated page would understate the open questions,
// which is the one number this product must never round down.
export interface ArtifactList {
  items: Artifact[];
  total: number;
  counts: { VERIFIED: number; UNOBSERVED: number; FAILED: number };
}

// Public recipients only — an identity never appears in this payload, which is what makes the
// escrow key escrow. `serverCanDecrypt` is derived server-side from whether an identity is stored.
export interface EncryptionKey {
  keyId: string;
  type: "operational" | "escrow";
  state: "active" | "retired";
  publicRecipient: string;
  serverCanDecrypt: boolean;
  createdAt: string;
}

// The escrow identity is present exactly once, in the response to its own creation, and is never
// retrievable again. Null when the operator supplied their own recipient — then the server never
// saw a private key at all.
export interface ProvisionedKeys {
  operationalKeyId: string;
  escrowKeyId: string;
  escrowIdentity: string | null;
  escrowIdentityWarning: string | null;
}

// What a rotation did and — the half that matters — what it did not. The server sends this on
// every rotation, success included, because a response carrying only an id would read as
// "exposure handled" and rotation does not handle exposure of artifacts already written.
export interface RotationConsequences {
  existingArtifactsUnchanged: boolean;
  predecessorReadableByServer: boolean;
  operatorMustRetain: string | null;
  doesNotRemediateExposure: string;
}

export interface RotatedKey {
  type: "operational" | "escrow";
  retiredKeyId: string;
  newKeyId: string;
  escrowIdentity: string | null;
  escrowIdentityWarning: string | null;
  consequences: RotationConsequences;
}
