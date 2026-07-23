// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Readable } from "node:stream";

export interface PutOptions {
  readonly contentType: string;
  // Multipart part size in bytes. See the s3 driver JSDoc for the partSize / max-object /
  // memory trade-off.
  readonly partSize: number;
  readonly metadata: Record<string, string>;
}

export interface PutResult {
  readonly etag: string;
  readonly sizeBytes: number;
  // Checksum reported by the provider, or null when the provider returns none.
  readonly checksum: string | null;
}

export interface ObjectMeta {
  readonly key: string;
  readonly sizeBytes: number;
  readonly etag: string;
  readonly lastModified: Date;
}

export interface Page<T> {
  readonly items: T[];
  // Continuation token for the next page, or null when the listing is exhausted.
  readonly cursor: string | null;
}

export interface HealthResult {
  readonly ok: boolean;
  readonly failedOperation: "put" | "get" | "delete" | null;
  // Human-readable reason (safe: never contains credentials), or null when healthy.
  readonly message: string | null;
}

export interface StorageDriver {
  put(key: string, body: Readable, opts: PutOptions): Promise<PutResult>;
  get(key: string): Promise<Readable>;
  head(key: string): Promise<ObjectMeta | null>;
  delete(keys: string[]): Promise<void>;
  list(prefix: string, cursor?: string): Promise<Page<ObjectMeta>>;
  canary(): Promise<HealthResult>;
}
