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

// <prefix>/<organizationId>/<jobId>/artifact.bin
export function artifactKey(prefix: string, organizationId: string, jobId: string): string {
  return joinKey(prefix, organizationId, jobId, "artifact.bin");
}

// <prefix>/<organizationId>/<jobId>/manifest.json
export function manifestKey(prefix: string, organizationId: string, jobId: string): string {
  return joinKey(prefix, organizationId, jobId, "manifest.json");
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
