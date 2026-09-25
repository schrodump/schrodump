// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The self-backup is the FAST recovery path for a lost metadata database — the alternative is
// rebuilding the catalog from every manifest in the bucket. So it is the copy an operator reaches
// for on the worst day, and the one place a truncated dump marked SUCCEEDED costs the most.

import { Readable, type Writable } from "node:stream";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import type { PrismaClient } from "@prisma/client";
import type { StorageDriver } from "@schrodump/storage/driver";
import type { RunOptions, RunResult, Runner } from "@schrodump/runner/runner";
import { describe, expect, it } from "vitest";
import { createSelfBackupPorts, type SelfBackupContext } from "./self-backup-wiring.js";

// Writes `bytes` to the dump stream and exits with `exitCode`. The runner reports a non-zero exit
// by RESOLVING with it; it does not throw. That is the whole defect: the upload path checked only
// whether the promise rejected.
function fakeRunner(exitCode: number, bytes: string, stderr = ""): Runner {
  return {
    run: (_descriptor, opts: RunOptions): Promise<RunResult> => {
      const out = opts.stdout as Writable | undefined;
      if (bytes.length > 0) out?.write(Buffer.from(bytes));
      out?.end();
      return Promise.resolve({ exitCode, stderr, durationMs: 1 });
    },
    withEphemeralService: () => Promise.reject(new Error("not used here")),
  };
}

function fakeDriver(deleted: string[]): StorageDriver {
  const unused = (): never => {
    throw new Error("not used here");
  };
  return {
    put: (_key: string, body: Readable) =>
      new Promise((resolve, reject) => {
        body.on("error", reject);
        body.resume();
        body.on("end", () => resolve({ etag: "e", sizeBytes: 0, checksum: null }));
      }),
    get: unused,
    head: unused,
    delete: (keys: string[]) => {
      deleted.push(...keys);
      return Promise.resolve();
    },
    list: unused,
    canary: unused,
  } as unknown as StorageDriver;
}

async function ports(runner: Runner, deleted: string[]) {
  const recipient = await identityToRecipient(await generateX25519Identity());
  const context: SelfBackupContext = {
    organizationId: "org-1",
    destinationId: "dest-1",
    driver: fakeDriver(deleted),
    prefix: "backups",
    recipients: [recipient],
    keyIds: ["k"],
  };
  return createSelfBackupPorts(
    {
      prisma: {
        selfBackup: { update: () => Promise.resolve({}) },
        // The adapter is picked from the metadata database's own major version rather than a
        // hardcoded tag, so the port asks for it before building the descriptor.
        $queryRaw: () => Promise.resolve([{ server_version_num: "180004" }]),
      } as unknown as PrismaClient,
      kek: Buffer.alloc(32),
      audit: { record: () => undefined },
      egress: { check: () => Promise.resolve(null) } as never,
      databaseUrl: "postgresql://u:p@db:5432/schrodump",
      destinationId: "dest-1",
      network: "internal",
      timeoutMs: 1000,
      runner,
    },
    context,
    "self-1",
  );
}

describe("the self-backup upload refuses a dump the tool did not finish", () => {
  it("fails on a non-zero exit even when bytes arrived, and says what the tool said", async () => {
    const deleted: string[] = [];
    const p = await ports(
      fakeRunner(1, "-- partial dump\n", "pg_dump: error: connection to server was lost"),
      deleted,
    );

    await expect(p.dumpAndUpload()).rejects.toThrow(/exit code 1/);
    // The tool's own words, not just the code: "exit code 1" alone is the reason an operator
    // cannot act on.
    await expect(
      ports(fakeRunner(1, "-- partial\n", "pg_dump: error: connection to server was lost"), []).then(
        (q) => q.dumpAndUpload(),
      ),
    ).rejects.toThrow(/connection to server was lost/);
    // The object is removed: one with no row and no manifest is one nothing will ever reclaim.
    expect(deleted).toContain("backups/_self/self-1/metadata.bin");
  });

  it("still fails when the tool exits 0 having written nothing", async () => {
    const deleted: string[] = [];
    const p = await ports(fakeRunner(0, ""), deleted);

    await expect(p.dumpAndUpload()).rejects.toThrow(/wrote nothing/);
    expect(deleted).toContain("backups/_self/self-1/metadata.bin");
  });

  it("accepts a dump the tool finished", async () => {
    const deleted: string[] = [];
    const p = await ports(fakeRunner(0, "-- a complete dump\n"), deleted);

    const upload = await p.dumpAndUpload();

    expect(upload.bucketKey).toBe("backups/_self/self-1/metadata.bin");
    expect(upload.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(deleted).toEqual([]);
  });
});
