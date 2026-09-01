// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Real SelfBackupPorts wiring: pg_dump of THIS deployment's metadata database -> gzip -> age ->
// the operator-named destination, plus a self-describing sidecar written in clear beside it.
//
// The sidecar is NOT called manifest.json. `scanManifests` sweeps every `*/manifest.json` under the
// destination prefix and catalog-rebuild turns each one into an Artifact row; a self-backup is not
// a catalog entry — it is how the catalog itself comes back — so it stays out of that sweep.

import { createHash } from "node:crypto";
import { PassThrough, Readable, Transform } from "node:stream";
import { createGzip } from "node:zlib";
import type { PrismaClient } from "@prisma/client";
import { resolveAdapter } from "@schrodump/engines/registry";
import type { Runner } from "@schrodump/runner/runner";
import type { StorageDriver } from "@schrodump/storage/driver";
import { encryptStream } from "../crypto/artifact.js";
import {
  selectSelfBackupRecipients,
  type SelfBackupPorts,
  type SelfBackupUpload,
} from "./self-backup.js";
import { driverForDestination } from "./destination-driver.js";

const PART_SIZE = 64 * 1024 * 1024;

export interface SelfBackupConnection {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tls: boolean;
}

// DATABASE_URL is a postgres URL; the executor needs its parts, not the string. Throws rather than
// guessing: a self-backup pointed at the wrong database is worse than one that did not run.
export function parseDatabaseUrl(raw: string): SelfBackupConnection {
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, "");
  if (database === "") throw new Error("DATABASE_URL has no database name");
  if (url.username === "") throw new Error("DATABASE_URL has no username");
  const sslmode = url.searchParams.get("sslmode");
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    database,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    // Matches libpq's own reading of the URL. `require` and stricter imply TLS; everything else,
    // including an absent sslmode, does not.
    tls: sslmode !== null && sslmode !== "disable" && sslmode !== "allow" && sslmode !== "prefer",
  };
}

export interface SelfBackupWiringDeps {
  prisma: PrismaClient;
  kek: Buffer;
  databaseUrl: string;
  destinationId: string;
  network: string;
  timeoutMs: number;
  runner: Runner;
  signal?: AbortSignal;
}

export interface SelfBackupContext {
  organizationId: string;
  destinationId: string;
  driver: StorageDriver;
  prefix: string;
  recipients: string[];
  keyIds: string[];
}

// Resolves everything the dump needs BEFORE a row is written, so a misconfiguration (unknown
// destination, no escrow key) is a boot-time complaint rather than a FAILED row every interval.
export async function resolveSelfBackupContext(
  deps: Pick<SelfBackupWiringDeps, "prisma" | "kek" | "destinationId">,
): Promise<SelfBackupContext> {
  // Unscoped by design: this is instance-level configuration, named by an operator with server
  // env access, and the deployment has no "current organization" at scheduler time.
  const destination = await deps.prisma.storageDestination.findUnique({
    where: { id: deps.destinationId },
  });
  if (destination === null)
    throw new Error(`self-backup destination ${deps.destinationId} does not exist`);

  const keys = await deps.prisma.encryptionKey.findMany({
    where: { organizationId: destination.organizationId },
  });
  // No cast: Prisma's KeyType/KeyState enums are lowercase and structurally match
  // SelfBackupRecipientKey, so renaming either enum breaks the build here instead of quietly
  // making every organization look like it has no escrow key.
  const chosen = selectSelfBackupRecipients(keys);

  const resolved = await driverForDestination(
    deps.prisma,
    deps.kek,
    destination.organizationId,
    deps.destinationId,
  );
  if (resolved === null) throw new Error("self-backup destination could not be opened");

  return {
    organizationId: destination.organizationId,
    destinationId: deps.destinationId,
    driver: resolved.driver,
    prefix: resolved.prefix,
    recipients: chosen.recipients,
    keyIds: chosen.keyIds,
  };
}

export function createSelfBackupPorts(
  deps: SelfBackupWiringDeps,
  context: SelfBackupContext,
  rowId: string,
): SelfBackupPorts {
  const base = `${context.prefix}/_self/${rowId}`;
  const bucketKey = `${base}/metadata.bin`;
  const manifestKey = `${base}/self-backup.json`;

  return {
    setState: async (state, reason) => {
      await deps.prisma.selfBackup.update({
        where: { id: rowId },
        data: {
          state,
          ...(reason !== undefined ? { reason } : {}),
          ...(state === "RUNNING" ? {} : { finishedAt: new Date() }),
        },
      });
    },

    dumpAndUpload: async () => {
      const connection = parseDatabaseUrl(deps.databaseUrl);
      // The metadata database is postgres by definition — Prisma's provider is `postgresql`, and
      // the schema is not portable. Asking the registry anyway keeps the image-per-version choice
      // in one place instead of hardcoding a tag here.
      const rows = await deps.prisma.$queryRaw<
        { server_version_num: string }[]
      >`SELECT current_setting('server_version_num') AS server_version_num`;
      const versionRaw = rows[0]?.server_version_num;
      if (versionRaw === undefined)
        throw new Error("could not read server_version_num from the metadata database");
      const descriptor = resolveAdapter("postgres").buildDump({
        connection,
        serverVersionNum: Number(versionRaw),
        executionMode: "STREAM",
        parallelism: 1,
        // The whole database, not a subset: a partial metadata dump restores to a catalog that
        // silently disagrees with the bucket.
        scope: { databases: [connection.database], schemas: [], collections: [] },
        facts: { isReplicaSet: false, hasMyisam: false },
      });

      const dumpOut = new PassThrough();
      const runPromise = deps.runner.run(descriptor, {
        network: deps.network,
        mounts: [],
        stdout: dumpOut,
        timeoutMs: deps.timeoutMs,
        correlationId: rowId,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      // Same reasoning as backup-wiring: attached in the tick the promise is created, because
      // encryptStream crosses a threadpool boundary and Node would flag the rejection first.
      runPromise.catch(() => undefined);

      let rawBytes = 0;
      const countRaw = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          rawBytes += chunk.length;
          callback(null, chunk);
        },
      });
      const encrypted = await encryptStream(
        dumpOut.pipe(countRaw).pipe(createGzip()),
        context.recipients,
      );
      const hash = createHash("sha256");
      let sizeBytes = 0;
      encrypted.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        sizeBytes += chunk.length;
      });

      const [putOutcome, runOutcome] = await Promise.allSettled([
        context.driver.put(bucketKey, encrypted, {
          contentType: "application/octet-stream",
          partSize: PART_SIZE,
          metadata: {},
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        }),
        runPromise,
      ]);
      if (runOutcome.status === "rejected") throw runOutcome.reason as Error;
      if (putOutcome.status === "rejected") throw putOutcome.reason as Error;

      // The same guard the artifact path grew after a STAGED dump shipped 318 empty bytes under a
      // SUCCEEDED job. pg_dump exiting 0 having written nothing is a failure wearing a success
      // code, and here it would be a metadata backup that restores to an empty catalog.
      if (rawBytes === 0) {
        await context.driver.delete([bucketKey]).catch(() => undefined);
        throw new Error("self-backup produced no data (pg_dump exited 0 but wrote nothing)");
      }

      return { bucketKey, manifestKey, sizeBytes, checksum: hash.digest("hex") };
    },

    writeManifest: async (upload: SelfBackupUpload) => {
      // Size and checksum are recorded on the row here, where they are known. A self-backup whose
      // size an operator cannot see is a self-backup they cannot sanity-check against the last one.
      await deps.prisma.selfBackup.update({
        where: { id: rowId },
        data: {
          bucketKey: upload.bucketKey,
          manifestKey: upload.manifestKey,
          sizeBytes: BigInt(upload.sizeBytes),
          checksum: upload.checksum,
        },
      });
      const sidecar = {
        selfBackupVersion: 1 as const,
        selfBackupId: rowId,
        organizationId: context.organizationId,
        destinationId: context.destinationId,
        bucketKey: upload.bucketKey,
        sizeCompressedBytes: upload.sizeBytes,
        checksumAlgorithm: "sha256",
        checksum: upload.checksum,
        compression: "gzip",
        encryption: { algorithm: "age", keyIds: context.keyIds },
        // Spelled out in the object itself, because whoever reads this file is mid-disaster and
        // will not have the docs open.
        recovery:
          "Decrypt with the OFFLINE escrow age identity, gunzip, then pg_restore into an empty " +
          "database. The operational identity was inside the database this file describes.",
        createdAt: new Date().toISOString(),
      };
      await context.driver.put(
        upload.manifestKey,
        Readable.from([Buffer.from(JSON.stringify(sidecar, null, 2), "utf8")]),
        { contentType: "application/json", partSize: PART_SIZE, metadata: {} },
      );
    },
  };
}
