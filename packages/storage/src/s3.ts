// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type ListObjectsV2CommandInput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { SchrodumpError } from "@schrodump/core/errors";
import { z } from "zod";
import type { HealthResult, ObjectMeta, Page, PutOptions, PutResult, StorageDriver } from "./driver.js";

/**
 * Configuration for one S3-compatible destination.
 *
 * `forcePathStyle` is an explicit user setting, NOT auto-detected: it must be `true` for
 * MinIO, SeaweedFS and Ceph RGW; Cloudflare R2 and Backblaze B2 accept virtual-hosted
 * style (`false`).
 *
 * `partSize` bounds the multipart upload. S3 allows at most 10_000 parts, so the largest
 * object is roughly `partSize * 10_000`: the 5 MiB SDK default caps uploads at ~50 GB,
 * which is why Schrodump defaults to 64 MiB (ceiling ~640 GB). Each in-flight upload
 * buffers up to one part per concurrent part in memory, so a larger `partSize` and more
 * concurrent uploads both raise peak memory usage.
 */
export const S3DestinationConfigSchema = z.object({
  endpoint: z.url().optional(),
  region: z.string().min(1),
  bucket: z.string().min(1),
  prefix: z.string(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean(),
  partSize: z
    .number()
    .int()
    .min(5 * 1024 * 1024)
    .default(64 * 1024 * 1024),
});

export type S3DestinationConfig = z.infer<typeof S3DestinationConfigSchema>;

// Credential-free view of a destination, safe to log or embed in errors.
export interface SafeDestination {
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly forcePathStyle: boolean;
  readonly partSize: number;
}

export function redactConfig(config: S3DestinationConfig): SafeDestination {
  return {
    endpoint: config.endpoint ?? null,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix,
    forcePathStyle: config.forcePathStyle,
    partSize: config.partSize,
  };
}

// Validates the raw config at the edge and returns a ready driver. Throws ZodError on
// invalid input (the error carries field paths, never the credential values).
export function createS3Driver(input: unknown): StorageDriver {
  return new S3Driver(S3DestinationConfigSchema.parse(input));
}

class S3Driver implements StorageDriver {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #safe: SafeDestination;

  constructor(config: S3DestinationConfig) {
    this.#bucket = config.bucket;
    this.#safe = redactConfig(config);

    const clientConfig: S3ClientConfig = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Recent AWS SDK v3 defaults (WHEN_SUPPORTED) send a CRC32 checksum on every request,
      // which several non-AWS providers reject. Only send/validate checksums when required.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    };
    this.#client = new S3Client(clientConfig);
  }

  async put(key: string, body: Readable, opts: PutOptions): Promise<PutResult> {
    const counted = countedStream(body);
    try {
      const upload = new Upload({
        client: this.#client,
        params: {
          Bucket: this.#bucket,
          Key: key,
          Body: counted.stream,
          ContentType: opts.contentType,
          Metadata: opts.metadata,
        },
        partSize: opts.partSize,
        leavePartsOnError: false,
      });
      const out = await upload.done();
      return {
        etag: stripQuotes(out.ETag),
        sizeBytes: counted.size(),
        checksum: providerChecksum(out),
      };
    } catch (err) {
      throw this.#wrap("put", key, err);
    }
  }

  async get(key: string): Promise<Readable> {
    try {
      const out = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      if (out.Body === undefined) {
        throw this.#wrap("get", key, new Error("empty response body"));
      }
      // In the Node.js runtime the streaming body is always a Readable.
      return out.Body as Readable;
    } catch (err) {
      throw this.#wrap("get", key, err);
    }
  }

  async head(key: string): Promise<ObjectMeta | null> {
    try {
      const out = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return {
        key,
        sizeBytes: out.ContentLength ?? 0,
        etag: stripQuotes(out.ETag),
        lastModified: out.LastModified ?? new Date(0),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw this.#wrap("head", key, err);
    }
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      for (const batch of chunkArray(keys, 1000)) {
        const out = await this.#client.send(
          new DeleteObjectsCommand({
            Bucket: this.#bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        // DeleteObjects reports per-object failures in the body, not as an exception.
        // Retention safety demands we never treat a silent partial failure as success.
        if (out.Errors !== undefined && out.Errors.length > 0) {
          throw new SchrodumpError("s3 delete reported per-object failures", {
            code: "STORAGE_DELETE_PARTIAL",
            correlationId: randomUUID(),
            context: {
              destination: this.#safe,
              failedKeys: out.Errors.map((e) => e.Key ?? ""),
              codes: out.Errors.map((e) => e.Code ?? ""),
            },
          });
        }
      }
    } catch (err) {
      if (err instanceof SchrodumpError) throw err;
      throw this.#wrap("delete", `${keys.length} keys`, err);
    }
  }

  async list(prefix: string, cursor?: string): Promise<Page<ObjectMeta>> {
    try {
      const input: ListObjectsV2CommandInput = { Bucket: this.#bucket, Prefix: prefix };
      if (cursor !== undefined) input.ContinuationToken = cursor;
      const out = await this.#client.send(new ListObjectsV2Command(input));
      const items = (out.Contents ?? []).map((o) => ({
        key: o.Key ?? "",
        sizeBytes: o.Size ?? 0,
        etag: stripQuotes(o.ETag),
        lastModified: o.LastModified ?? new Date(0),
      }));
      return { items, cursor: out.IsTruncated === true ? (out.NextContinuationToken ?? null) : null };
    } catch (err) {
      throw this.#wrap("list", prefix, err);
    }
  }

  async canary(): Promise<HealthResult> {
    const key = this.#canaryKey();
    try {
      await this.put(key, Readable.from([Buffer.from("schrodump-canary")]), {
        contentType: "application/octet-stream",
        partSize: 5 * 1024 * 1024,
        metadata: {},
      });
    } catch {
      return { ok: false, failedOperation: "put", message: "PUT failed" };
    }
    try {
      await drain(await this.get(key));
    } catch {
      return { ok: false, failedOperation: "get", message: "GET failed" };
    }
    try {
      await this.delete([key]);
    } catch {
      return { ok: false, failedOperation: "delete", message: "DELETE failed" };
    }
    return { ok: true, failedOperation: null, message: null };
  }

  #canaryKey(): string {
    const base = this.#safe.prefix.replace(/\/+$/, "");
    const suffix = `.schrodump-health/${randomUUID()}`;
    return base.length > 0 ? `${base}/${suffix}` : suffix;
  }

  #wrap(operation: string, keyInfo: string, err: unknown): SchrodumpError {
    const awsError = err instanceof Error ? err.name : "UnknownError";
    return new SchrodumpError(`s3 ${operation} failed: ${awsError}`, {
      code: `STORAGE_${operation.toUpperCase()}_FAILED`,
      correlationId: randomUUID(),
      context: { operation, key: keyInfo, destination: this.#safe, awsError },
      cause: err,
    });
  }
}

interface ChecksumFields {
  readonly ChecksumSHA256?: string | undefined;
  readonly ChecksumCRC32C?: string | undefined;
  readonly ChecksumCRC32?: string | undefined;
  readonly ChecksumSHA1?: string | undefined;
}

function providerChecksum(out: ChecksumFields): string | null {
  return out.ChecksumSHA256 ?? out.ChecksumCRC32C ?? out.ChecksumCRC32 ?? out.ChecksumSHA1 ?? null;
}

function stripQuotes(value: string | undefined): string {
  return value !== undefined ? value.replace(/^"|"$/g, "") : "";
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (meta?.httpStatusCode === 404) return true;
  const name = (err as { name?: string }).name;
  return name === "NotFound" || name === "NoSuchKey";
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// Passes a stream through unchanged while tallying its byte length — lets us report the
// uploaded size for streams whose length is unknown up front.
function countedStream(source: Readable): { stream: Readable; size: () => number } {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(null, chunk);
    },
  });
  source.on("error", (err) => counter.destroy(err));
  source.pipe(counter);
  return { stream: counter, size: () => size };
}

function drain(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("data", () => undefined);
    stream.on("end", () => resolve());
    stream.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}
