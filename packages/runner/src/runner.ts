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
  // Process-wide cancellation. Aborting it kills the container through the same teardown the
  // timeout uses — the shutdown path depends on this to leave no container and no cleartext
  // scratch behind. Optional: callers with no shutdown story (tests, one-off tools) omit it.
  readonly signal?: AbortSignal;
}

export interface RunResult {
  // Read from the container's StatusCode — success is exitCode === 0, never inferred from EOF.
  readonly exitCode: number;
  // Truncated and sanitized.
  readonly stderr: string;
  readonly durationMs: number;
}

// A long-lived SERVICE container: start -> become ready -> let other executors connect -> destroy.
// Distinct from `run()`'s one-shot shape (start -> wait for exit -> remove).
export interface EphemeralServiceSpec {
  readonly image: string;
  readonly env: Record<string, string>;
  readonly network: string;
  readonly readinessCommand: string[]; // exec'd in the container; exit 0 = ready
  readonly port: number; // in-container listen port
  readonly correlationId: string;
  readonly readinessTimeoutMs: number; // bounds readiness polling
}

export interface EphemeralServiceHandle {
  readonly host: string;
  readonly port: number;
}

// `engines` says WHAT to run (the descriptor); a Runner says WHERE. DockerRunner today,
// AgentRunner (physical backup) later — same interface, no change to `engines`.
export interface Runner {
  run(descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult>;
  // Provisions an ephemeral service, waits for readiness, hands the caller a connectable
  // address, then always tears the container down — even if `use` throws.
  withEphemeralService<T>(
    spec: EphemeralServiceSpec,
    use: (handle: EphemeralServiceHandle) => Promise<T>,
  ): Promise<T>;
}
