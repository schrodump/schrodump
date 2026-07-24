// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Writable } from "node:stream";
import type { ExecutionDescriptor } from "@schrodump/core/execution";

// The concrete Docker-backed Runner, surfaced on the package's primary entry so composers depend
// on `@schrodump/runner/runner` rather than the docker.ts implementation module.
export { createDockerRunner } from "./docker.js";

export interface RunMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface RunOptions {
  // The Docker network the executor joins. Always explicit — never inherited by accident.
  readonly network: string;
  readonly mounts: RunMount[];
  // Destination for the container's stdout when descriptor.outputKind === 'stdout'.
  readonly stdout?: Writable;
  readonly timeoutMs: number;
  readonly correlationId: string;
}

export interface RunResult {
  // Read from the container's StatusCode — success is exitCode === 0, never inferred from EOF.
  readonly exitCode: number;
  // Truncated and sanitized.
  readonly stderr: string;
  readonly durationMs: number;
}

// `engines` says WHAT to run (the descriptor); a Runner says WHERE. DockerRunner today,
// AgentRunner (physical backup) later — same interface, no change to `engines`.
export interface Runner {
  run(descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult>;
}
