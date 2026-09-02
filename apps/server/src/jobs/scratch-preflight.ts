// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Refuse to start when scratch is configured and unwritable.
//
// Scratch used to be a named volume, which Docker creates with ownership matching the container.
// Making it a host bind mount — which it had to become, because executors mount files out of it and
// the daemon resolves those paths on the host — moved that responsibility to the operator, who
// naturally creates the directory as root. The container runs as an unprivileged user.
//
// The failure that produces is the one this product exists to prevent, and it is quiet: STREAM
// backups keep succeeding because nothing is mounted for them, while verify, restore, STAGED and
// every mongo job fail. Artifacts accumulate that nothing can check. The operator sees green
// backups and a verify that "could not run".
//
// So the server refuses to boot instead, the way it already refuses on a KEK that does not match
// its fingerprint, and the message carries the uid and the command rather than the diagnosis alone.

export interface ScratchPreflightDeps {
  // Injected so the check is testable without touching a filesystem.
  readonly access: (path: string) => Promise<void>;
  readonly uid: () => number;
}

export class ScratchNotWritableError extends Error {
  constructor(root: string, uid: number, cause: unknown) {
    super(
      `scratch is configured at ${root} but this process cannot write there. Executors mount ` +
        `files out of scratch — the decrypted artifact on restore, the staging directory for a ` +
        `STAGED dump, mongo's --config file — so an unwritable scratch leaves backups succeeding ` +
        `while nothing can be verified or restored. This process runs as uid ${String(uid)}: ` +
        `\`chown -R ${String(uid)} ${root}\` on the host, or set SCHRODUMP_SCRATCH_PATH to a ` +
        `directory it owns.`,
    );
    this.name = "ScratchNotWritableError";
    this.cause = cause;
  }
}

export async function assertScratchWritable(
  root: string,
  deps: ScratchPreflightDeps,
): Promise<void> {
  try {
    await deps.access(root);
  } catch (err) {
    throw new ScratchNotWritableError(root, deps.uid(), err);
  }
}
