// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Readable } from "node:stream";
import {
  parseManifest,
  serializeManifest,
  type Manifest,
  type ManifestParseIssue,
  type ManifestParseResult,
} from "@schrodump/core/manifest";
import type { StorageDriver } from "./driver.js";

// The sidecar object is tiny (a single PutObject in practice); this only has to be a valid
// multipart part size.
const SIDECAR_PART_SIZE = 5 * 1024 * 1024;
const MANIFEST_SUFFIX = "/manifest.json";

function joinKey(...segments: string[]): string {
  return segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter((segment) => segment.length > 0)
    .join("/");
}

// THE key builder. Every object a backup writes goes through this one, and so does everything that
// reads or deletes one, because the two used to disagree and the disagreement was silent.
//
// The destination form defaults `prefix` to "". A template literal then writes
// `/<org>/<job>/artifact.bin` — S3 keys may begin with a slash and that one is a different key from
// `<org>/<job>/artifact.bin`, which is what this function returns. So on every deployment that took
// the default prefix, the artifact was written at one key and retention deleted another: the row
// and the manifest went, `artifact.bin` and `globals.bin` stayed, and the job reported
// "retention kept 7, deleted 1". Observed on a real instance, where the same Artifact row carried
// `bucketKey = "/cmtq…"` and `manifestKey = "cmtq…"` — the two paths, side by side, in one row.
//
// Storage the operator pays for outside the window they configured, forever, and — since
// `pg_dumpall --globals-only` emits `CREATE ROLE … PASSWORD 'SCRAM-SHA-256$…'` — role password
// hashes surviving the retention that was supposed to age them out.
export function objectKey(
  prefix: string,
  organizationId: string,
  jobId: string,
  name: string,
): string {
  return joinKey(prefix, organizationId, jobId, name);
}

// <prefix>/<organizationId>/<jobId>/artifact.bin
export function artifactKey(prefix: string, organizationId: string, jobId: string): string {
  return objectKey(prefix, organizationId, jobId, "artifact.bin");
}

// <prefix>/<organizationId>/<jobId>/manifest.json
export function manifestKey(prefix: string, organizationId: string, jobId: string): string {
  return objectKey(prefix, organizationId, jobId, "manifest.json");
}

// Writes the manifest IN CLEAR next to its artifact, using the deterministic serialization
// from @schrodump/core.
export async function writeManifest(
  driver: StorageDriver,
  prefix: string,
  manifest: Manifest,
): Promise<void> {
  const key = manifestKey(prefix, manifest.organizationId, manifest.jobId);
  const body = Buffer.from(serializeManifest(manifest), "utf8");
  await driver.put(key, Readable.from([body]), {
    contentType: "application/json",
    partSize: SIDECAR_PART_SIZE,
    metadata: {},
  });
}

export async function readManifest(
  driver: StorageDriver,
  prefix: string,
  organizationId: string,
  jobId: string,
): Promise<ManifestParseResult> {
  const raw = await readAll(await driver.get(manifestKey(prefix, organizationId, jobId)));
  return parseManifest(safeJsonParse(raw));
}

export interface InvalidManifest {
  readonly key: string;
  readonly issues: readonly ManifestParseIssue[];
}

export interface ScanResult {
  readonly manifests: Manifest[];
  readonly invalid: InvalidManifest[];
}

// Rebuilds the catalog straight from the bucket — the recovery path when the metadata
// database is lost. It keeps no local state: it pages the listing and parses every
// manifest.json it finds, separating the ones that fail validation instead of throwing.
export async function scanManifests(driver: StorageDriver, prefix: string): Promise<ScanResult> {
  const manifests: Manifest[] = [];
  const invalid: InvalidManifest[] = [];

  let cursor: string | undefined;
  do {
    const page = await driver.list(prefix, cursor);
    for (const object of page.items) {
      if (!object.key.endsWith(MANIFEST_SUFFIX)) continue;
      const result = parseManifest(safeJsonParse(await readAll(await driver.get(object.key))));
      if (result.ok) {
        manifests.push(result.manifest);
      } else {
        invalid.push({ key: object.key, issues: result.error.issues });
      }
    }
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);

  return { manifests, invalid };
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A malformed body becomes a structured validation error via parseManifest(null).
    return null;
  }
}
