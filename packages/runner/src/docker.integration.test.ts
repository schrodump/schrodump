// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import Docker from "dockerode";
import { SchrodumpError } from "@schrodump/core/errors";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import { createDockerRunner } from "./docker.js";

// Opt-in only: needs a Docker daemon. Skipped unless SCHRODUMP_TEST_INTEGRATION=1.
const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";
const IMAGE = "alpine:3";

async function pull(docker: Docker, image: string): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

const nullSink = (): Writable =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

describe.skipIf(!enabled)("DockerRunner integration (real dockerode)", () => {
  it("reads a non-zero StatusCode from a real container", async () => {
    const docker = new Docker();
    await pull(docker, IMAGE);
    const runner = createDockerRunner(docker);
    const descriptor: ExecutionDescriptor = {
      image: IMAGE,
      command: ["sh", "-c", "echo hi; exit 3"],
      env: {},
      outputKind: "stdout",
    };
    const result = await runner.run(descriptor, {
      network: "bridge",
      mounts: [],
      stdout: nullSink(),
      timeoutMs: 30_000,
      correlationId: "it-exit",
    });
    expect(result.exitCode).toBe(3);
  }, 120_000);

  it("times out and kills a long-running container", async () => {
    const docker = new Docker();
    await pull(docker, IMAGE);
    const runner = createDockerRunner(docker);
    const descriptor: ExecutionDescriptor = {
      image: IMAGE,
      command: ["sleep", "60"],
      env: {},
      outputKind: "stdout",
    };
    await expect(
      runner.run(descriptor, {
        network: "bridge",
        mounts: [],
        stdout: nullSink(),
        timeoutMs: 1_000,
        correlationId: "it-timeout",
      }),
    ).rejects.toBeInstanceOf(SchrodumpError);
  }, 120_000);
});
