// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SchrodumpError } from "@schrodump/core/errors";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import {
  DockerRunner,
  sanitizeStderr,
  type ContainerSpec,
  type DockerEngine,
  type StartedContainer,
} from "./docker.js";
import type { RunOptions } from "./runner.js";

class FakeEngine implements DockerEngine {
  networkOk = true;
  statusCode = 0;
  neverExits = false;
  stdoutChunks: Buffer[] = [];
  stderrChunks: Buffer[] = [];
  started = false;
  killed = false;
  removed = false;
  lastSpec: ContainerSpec | undefined;

  async networkExists(): Promise<boolean> {
    return this.networkOk;
  }

  async start(spec: ContainerSpec): Promise<StartedContainer> {
    this.started = true;
    this.lastSpec = spec;
    return {
      stdout: Readable.from(this.stdoutChunks),
      stderr: Readable.from(this.stderrChunks),
      wait: () =>
        this.neverExits ? new Promise<number>(() => undefined) : Promise.resolve(this.statusCode),
      kill: async () => {
        this.killed = true;
      },
      remove: async () => {
        this.removed = true;
      },
    };
  }
}

const DESCRIPTOR: ExecutionDescriptor = {
  image: "postgres:16-alpine",
  command: ["pg_dump", "-Fc"],
  env: { PGPASSWORD: "s3cret", PGSSLMODE: "require" },
  outputKind: "stdout",
};

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return { network: "schrodump_targets", mounts: [], timeoutMs: 5000, correlationId: "corr-1", ...over };
}

describe("DockerRunner.run", () => {
  it("reports failure via StatusCode when the container exits non-zero, despite clean stdout", async () => {
    const engine = new FakeEngine();
    engine.statusCode = 3;
    engine.stdoutChunks = [Buffer.from("partial dump bytes")]; // stream ends clean, exit != 0
    const result = await new DockerRunner(engine).run(DESCRIPTOR, opts());
    expect(result.exitCode).toBe(3);
    expect(engine.removed).toBe(true);
  });

  it("returns exit code 0 on success and removes the container", async () => {
    const engine = new FakeEngine();
    engine.stdoutChunks = [Buffer.from("dump")];
    const result = await new DockerRunner(engine).run(DESCRIPTOR, opts());
    expect(result.exitCode).toBe(0);
    expect(engine.removed).toBe(true);
  });

  it("kills the container and throws a typed error on timeout", async () => {
    const engine = new FakeEngine();
    engine.neverExits = true;
    await expect(
      new DockerRunner(engine).run(DESCRIPTOR, opts({ timeoutMs: 30 })),
    ).rejects.toBeInstanceOf(SchrodumpError);
    expect(engine.killed).toBe(true);
    expect(engine.removed).toBe(true);
  });

  it("fails clearly and never starts a container when the network is missing", async () => {
    const engine = new FakeEngine();
    engine.networkOk = false;
    await expect(new DockerRunner(engine).run(DESCRIPTOR, opts())).rejects.toBeInstanceOf(
      SchrodumpError,
    );
    expect(engine.started).toBe(false);
  });

  it("streams container stdout to the provided destination", async () => {
    const engine = new FakeEngine();
    engine.stdoutChunks = [Buffer.from("dump-"), Buffer.from("bytes")];
    const received: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received.push(Buffer.from(chunk));
        callback();
      },
    });
    await new DockerRunner(engine).run(DESCRIPTOR, opts({ stdout: sink }));
    expect(Buffer.concat(received).toString()).toBe("dump-bytes");
  });

  it("sanitizes the password out of captured stderr", async () => {
    const engine = new FakeEngine();
    engine.stderrChunks = [Buffer.from("FATAL: auth failed for postgres://backup:s3cret@db/app")];
    const result = await new DockerRunner(engine).run(DESCRIPTOR, opts());
    expect(result.stderr).not.toContain("s3cret");
    expect(result.stderr).toContain("[redacted]");
  });

  it("passes the explicit network to the engine", async () => {
    const engine = new FakeEngine();
    await new DockerRunner(engine).run(DESCRIPTOR, opts({ network: "schrodump_targets" }));
    expect(engine.lastSpec?.network).toBe("schrodump_targets");
  });
});

describe("sanitizeStderr", () => {
  it("redacts credential env values and connection-string passwords, leaving non-secrets", () => {
    const out = sanitizeStderr("postgres://u:s3cret@h failed; password=s3cret; mode require", {
      PGPASSWORD: "s3cret",
      PGSSLMODE: "require",
    });
    expect(out).not.toContain("s3cret");
    expect(out).toContain("require");
  });
});
