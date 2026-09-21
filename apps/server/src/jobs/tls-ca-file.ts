// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Materializes a target's CA certificate for the executors that connect to it. The descriptors in
// @schrodump/engines name TLS_CA_PATH (PGSSLROOTCERT, --ssl-ca, --ca, --sslCAFile); this is what
// puts a file there — written onto the scratch volume and bind-mounted read-only, exactly as the
// mongo `--config` file is (crypto/mongo-config.ts), because a RunMount.source must be a path the
// Docker daemon can resolve and the scratch volume is the one such path this server has.
//
// What differs from the mongo file is what the CA is: public. It needs no 0700 reservation to stay
// confidential and no place in the staged-concurrency budget, which is why the backup path gives it
// a directory of its own rather than a ScratchManager reservation (see stageTlsCaForBackup). The
// file is 0644 for the same reason the mongo file is: the mongo image drops to an unprivileged uid
// before running the tools, and a file it cannot read is a verification that cannot happen.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TLS_CA_PATH } from "@schrodump/engines/descriptor";
import type { RunMount } from "@schrodump/runner/runner";

// Said the way MONGO_CONFIG_SCRATCH_REQUIRED_REASON says it: the job fails first and legibly, rather
// than an executor failing later on a file that was never there.
export const TLS_CA_SCRATCH_REQUIRED_REASON =
  "a target with a CA certificate requires a configured scratch path: the certificate is " +
  "bind-mounted into the executor from there";

export interface TlsCaFile {
  // Read-only, at TLS_CA_PATH inside the executor.
  readonly mount: RunMount;
  cleanup(): Promise<void>;
}

// Writes the PEM into `dir` (which must already exist) and returns the read-only mount.
export async function writeTlsCaFile(dir: string, pem: string): Promise<TlsCaFile> {
  const source = join(dir, `tls-ca-${randomUUID()}.pem`);
  await writeFile(source, pem, { mode: 0o644 });
  // writeFile's mode is masked by umask; enforce it (mirrors writeMongoConfig).
  await chmod(source, 0o644);
  return {
    mount: { source, target: TLS_CA_PATH, readOnly: true },
    cleanup: () => rm(source, { force: true }),
  };
}

// The backup's CA lives in a directory of its own on the scratch volume, NOT in a ScratchManager
// reservation. A STAGED dump takes the job's reservation itself, and the two cannot share it:
// `pg_dump -Fd` refuses a staging directory that is not empty and the archive step would tar the CA
// into the artifact; a second reservation takes a second staged-concurrency slot, which deadlocks
// the job against itself at SCHRODUMP_MAX_CONCURRENT_STAGED=1. A public certificate needs neither
// the slot nor the space check — only a daemon-resolvable path — so it gets exactly that.
export function tlsCaDirFor(scratchRoot: string, jobId: string): string {
  return join(scratchRoot, `${jobId}.tls-ca`);
}

export async function stageTlsCaForBackup(
  scratchRoot: string,
  jobId: string,
  pem: string,
): Promise<TlsCaFile> {
  const dir = tlsCaDirFor(scratchRoot, jobId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const file = await writeTlsCaFile(dir, pem);
    return { mount: file.mount, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
