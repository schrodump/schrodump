// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Artifact manifest.
//
// This object is written IN CLEAR next to the artifact in the bucket and is what allows
// the entire catalog to be reconstructed if the metadata database is lost.
//
// Rigid rules:
//   1. The manifest NEVER contains a credential, connection string, key material, or a
//      sample of data.
//   2. `encryption.keyIds` are key FINGERPRINTS — never the key itself.
//   3. `dependsOn` exists from day one to support the full/incremental chain once
//      physical backup lands. It lists the jobIds this artifact depends on.

import { z } from "zod";
import { COMPRESSION_ALGORITHMS, ENGINE_KINDS, EXECUTION_MODES } from "./types.js";

export const ManifestSchema = z.object({
  // Literal for forward evolution: a v2 manifest fails a v1 parse loudly.
  manifestVersion: z.literal(1),
  // `jobId` is the identity of the manifest/artifact; `dependsOn` and retention key on it.
  jobId: z.string().min(1),
  organizationId: z.string().min(1),
  engine: z.enum(ENGINE_KINDS),
  serverVersionNum: z.number().int().min(0),
  toolVersion: z.string().min(1),
  executionMode: z.enum(EXECUTION_MODES),
  parallelism: z.number().int().min(1),
  scope: z.object({
    databases: z.array(z.string()),
    schemas: z.array(z.string()),
    collections: z.array(z.string()),
  }),
  sizeRawBytes: z.number().int().min(0),
  sizeCompressedBytes: z.number().int().min(0),
  checksumAlgorithm: z.string().min(1),
  checksum: z.string().min(1),
  compression: z.enum(COMPRESSION_ALGORITHMS),
  encryption: z.object({
    algorithm: z.string().min(1),
    // Fingerprints of the recipients (operational + escrow), never the keys.
    keyIds: z.array(z.string().min(1)).min(1),
  }),
  dependsOn: z.array(z.string()),
  createdAt: z.iso.datetime({ offset: true }),
  durationMs: z.number().int().min(0),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export interface ManifestParseIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: Manifest }
  | {
      readonly ok: false;
      readonly error: { readonly message: string; readonly issues: readonly ManifestParseIssue[] };
    };

// Validates without throwing: callers branch on `ok` and get structured issues.
export function parseManifest(input: unknown): ManifestParseResult {
  const result = ManifestSchema.safeParse(input);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
  return { ok: false, error: { message: "manifest failed validation", issues } };
}

// Recursively sorts object keys; array order is preserved (it is semantically meaningful).
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

// Deterministic serialization: the manifest is compared by checksum, so the same manifest
// must always produce the same bytes regardless of key insertion order.
export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(sortDeep(manifest));
}
