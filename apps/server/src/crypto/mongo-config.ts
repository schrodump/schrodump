// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Materializes mongodump/mongorestore's `--config` credential file. The mongo tools read the
// password from a YAML file so it never lands on argv (visible to any host process); the descriptors
// in @schrodump/engines already pass `--config MONGO_CONFIG_PATH`, but nothing wrote or mounted that
// file — so mongo backup/restore was not wired end-to-end. This is the write side.
//
// The file holds a live credential in CLEARTEXT. It lives inside the caller's 0700 scratch
// reservation (the same swept, deploy-encrypted volume as the decrypted dump, and — because a
// RunMount.source is a Docker-daemon path — the only place an executor bind mount can read it from),
// and is removed via `cleanup`. The password never reaches a log or an error message.
//
// The FILE itself is world-readable (0644), NOT owner-only (0600): the mongodump/mongorestore
// executor bind-mounts it and must read it, but the container process does not share the host uid
// that wrote it, so a 0600 file is unreadable inside the container — mongodump then fails
// `error opening file with --config: open <path>: permission denied`, falls through to a stdin
// password prompt it has no terminal for, and the dump exits non-zero. (This never reproduces on
// Docker Desktop, whose VM file-sharing masks the mounted file's ownership; it is a native-Linux
// executor failure, caught by CI.) Confidentiality is preserved by the enclosing 0700 reservation
// directory — no other host user can traverse into it to reach this file — so world-read on the file
// costs nothing on the host while letting the throwaway executor read the one credential it needs.

import { chmod, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MONGO_CONFIG_PATH } from "@schrodump/engines/adapters/mongodb";
import type { RunMount } from "@schrodump/runner/runner";

export interface MongoConfigFile {
  // Read-only mount of the config file at MONGO_CONFIG_PATH inside the mongo executor.
  readonly mount: RunMount;
  // Removes the credential file. The caller also releases the reservation (which recursively removes
  // the dir) as a backstop; this narrows the cleartext window to the executor run itself.
  cleanup(): Promise<void>;
}

// Writes `password: <value>` into `dir` and returns the read-only RunMount + a cleanup.
//
// The value is JSON.stringify'd, NOT interpolated raw. YAML is a superset of JSON flow scalars, so a
// JSON string literal is a valid YAML double-quoted scalar. This matters for correctness, not just
// hygiene: verified against mongo:8's tools, a naive `password: <pw>` turns a leading '#' into a YAML
// comment (empty password) and misparses ':' / quotes, after which mongodump falls back to prompting
// for the password on stdin — which the headless executor has none of, so it hangs to timeout.
export async function writeMongoConfig(dir: string, password: string): Promise<MongoConfigFile> {
  const source = join(dir, `mongo-config-${randomUUID()}.yaml`);
  // 0644, not 0600: the executor container reads this mounted file as a uid that does not own it, so
  // owner-only would be `permission denied` inside the container (see the header). The 0700 reservation
  // dir is what keeps the credential confidential on the host.
  await writeFile(source, `password: ${JSON.stringify(password)}\n`, { mode: 0o644 });
  // writeFile's mode is masked by umask; enforce 0644 explicitly (mirrors scratch.ts's chmod).
  await chmod(source, 0o644);
  return {
    mount: { source, target: MONGO_CONFIG_PATH, readOnly: true },
    cleanup: () => rm(source, { force: true }),
  };
}
