// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Turning a directory dump into a stream, and back.
//
// A STAGED dump writes a DIRECTORY (pg_dump -Fd, mydumper), but the artifact pipeline moves a
// single stream: container stdout -> gzip -> age -> one S3 object. Nothing bridged the two, which
// is how a STAGED backup came to upload an empty artifact under a SUCCEEDED job. These two
// descriptors are that bridge.
//
// Deliberately engine-independent and deliberately NOT a new executor image. `tar` is already
// present in every image the engines resolve (alpine's busybox and the mysql/mariadb images all
// ship it), so the caller passes the image its own adapter already chose. A dedicated tar image
// would add a supply-chain surface — another tag, another digest to pin and re-pin — to run a
// command the existing images already have.
//
// No credential is involved on either side: the archive step reads a directory that has already
// been written, and the extract step reads a file. Both carry an empty env, which is the point —
// there is no reason for a target's password to travel with them.

import type { ExecutionDescriptor } from "@schrodump/core/execution";

export interface ArchiveStagingInput {
  readonly image: string;
  // Directory inside the executor, mounted from the scratch reservation.
  readonly stagingPath: string;
}

export function buildArchiveStaging(input: ArchiveStagingInput): ExecutionDescriptor {
  return {
    image: input.image,
    // `-C <dir> .` rather than taring the path itself: the archive then holds the directory's
    // CONTENTS at its root, so extraction needs no --strip-components and the archive carries no
    // absolute path from the machine that produced it.
    command: ["tar", "-cf", "-", "-C", input.stagingPath, "."],
    env: {},
    outputKind: "stdout",
  };
}

export interface ExtractStagingInput {
  readonly image: string;
  // The decrypted tar, mounted read-only.
  readonly sourcePath: string;
  // Directory to extract into. Must exist and be writable by the executor's uid.
  readonly targetPath: string;
}

export function buildExtractStaging(input: ExtractStagingInput): ExecutionDescriptor {
  return {
    image: input.image,
    command: ["tar", "-xf", input.sourcePath, "-C", input.targetPath],
    env: {},
    outputKind: "directory",
  };
}
