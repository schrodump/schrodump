// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The scratch directory holds the dump IN CLEAR. In `directory` mode pg_dump/mydumper write
// the files themselves, so there is no way to encrypt inline. Mitigation: a dedicated volume,
// 0700 permissions, delete in `finally`, and a host-encrypted filesystem — the last is the
// operator's responsibility and MUST be documented in the deploy guide.

import { chmod, mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { SchrodumpError } from "@schrodump/core/errors";

const DEFAULT_SAFETY_FACTOR = 1.5;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ScratchConfig {
  root: string;
  maxConcurrentStaged: number;
  safetyFactor?: number;
  maxAgeMs?: number;
  // Injectable for testing the space pre-check; defaults to a statfs on the volume.
  freeSpaceProbe?: (path: string) => Promise<number>;
}

export interface Reservation {
  readonly jobId: string;
  readonly path: string;
  release(): Promise<void>;
}

// Counting semaphore honoring SCHRODUMP_MAX_CONCURRENT_STAGED.
class Semaphore {
  readonly #max: number;
  #inUse = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(max: number) {
    this.#max = max;
  }

  acquire(): Promise<void> {
    if (this.#inUse < this.#max) {
      this.#inUse++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next(); // hand the slot straight to the next waiter; inUse stays the same
    } else {
      this.#inUse--;
    }
  }
}

async function statfsFree(path: string): Promise<number> {
  const info = await statfs(path);
  return info.bavail * info.bsize;
}

export class ScratchManager {
  readonly #root: string;
  readonly #safetyFactor: number;
  readonly #maxAgeMs: number;
  readonly #freeSpace: (path: string) => Promise<number>;
  readonly #semaphore: Semaphore;
  readonly #active = new Set<string>();

  constructor(config: ScratchConfig) {
    this.#root = config.root;
    this.#safetyFactor = config.safetyFactor ?? DEFAULT_SAFETY_FACTOR;
    this.#maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.#freeSpace = config.freeSpaceProbe ?? statfsFree;
    this.#semaphore = new Semaphore(config.maxConcurrentStaged);
  }

  // Pre-checks real free space against the probed estimate BEFORE the dump starts, and refuses
  // the job if it would not fit with the safety margin. A full disk mid-dump is worse than a
  // job that never started — it leaves garbage and can take down other containers on the host.
  async reserve(jobId: string, estimatedBytes: number): Promise<Reservation> {
    await this.#semaphore.acquire();
    try {
      const free = await this.#freeSpace(this.#root);
      const required = estimatedBytes * this.#safetyFactor;
      if (free < required) {
        throw new SchrodumpError("insufficient scratch space for the estimated dump size", {
          code: "RUNNER_SCRATCH_INSUFFICIENT_SPACE",
          correlationId: jobId,
          context: { jobId, estimatedBytes, requiredBytes: required, freeBytes: free },
        });
      }

      const path = join(this.#root, jobId);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700); // mkdir's mode is subject to umask; enforce 0700 explicitly
      this.#active.add(jobId);

      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await rm(path, { recursive: true, force: true });
        } finally {
          this.#active.delete(jobId);
          this.#semaphore.release();
        }
      };
      return { jobId, path, release };
    } catch (err) {
      this.#semaphore.release();
      throw err;
    }
  }

  // Boot-time and periodic sweep: removes directories with no active job that exceed the age
  // ceiling. Without it the disk fills over weeks and the failure looks like "backups just
  // stopped working" with no obvious cause. Returns the names removed.
  async gc(): Promise<string[]> {
    const now = Date.now();
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return [];
    }

    const removed: string[] = [];
    for (const name of entries) {
      if (this.#active.has(name)) continue; // an active job owns this directory
      const path = join(this.#root, name);
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      if (now - info.mtimeMs < this.#maxAgeMs) continue; // still under the age ceiling
      try {
        await rm(path, { recursive: true, force: true });
        removed.push(name);
      } catch {
        // leave it for the next sweep rather than failing the whole gc
      }
    }
    return removed;
  }
}
