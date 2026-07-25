// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SchrodumpError } from "@schrodump/core/errors";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import {
  DockerRunner,
  sanitizeStderr,
  type ContainerSpec,
  type DockerEngine,
  type EphemeralServiceSpec,
  type StartedContainer,
  type StartedService,
} from "./docker.js";
import type { RunOptions } from "./runner.js";

interface FakeEngineOptions {
  readyAfter: number; // number of exec() calls before exec returns 0; Infinity = never ready
}

class FakeEngine implements DockerEngine {
  networkOk = true;
  startFails = false;
  statusCode = 0;
  neverExits = false;
  stdoutChunks: Buffer[] = [];
  stderrChunks: Buffer[] = [];
  started = false;
  killed = false;
  removed = false;
  lastSpec: ContainerSpec | undefined;

  readonly #readyAfter: number;
  execCalls = 0;
  serviceRemoved = false;
  startServiceCalled = false;
  lastServiceHost: string | undefined;

  constructor(options: FakeEngineOptions = { readyAfter: 1 }) {
    this.#readyAfter = options.readyAfter;
  }

  async networkExists(): Promise<boolean> {
    return this.networkOk;
  }

  async start(spec: ContainerSpec): Promise<StartedContainer> {
    this.lastSpec = spec;
    // Mirrors dockerode's createContainer rejecting on an absent image ("No such image"): the
    // container never comes up and nothing is ever written to opts.stdout.
    if (this.startFails) throw new Error("No such image: postgres:16-alpine");
    this.started = true;
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

  async startService(spec: EphemeralServiceSpec): Promise<StartedService> {
    this.startServiceCalled = true;
    const host = `svc-${spec.image}`;
    this.lastServiceHost = host;
    return {
      host,
      exec: async () => {
        this.execCalls += 1;
        return this.execCalls >= this.#readyAfter ? 0 : 1;
      },
      remove: async () => {
        this.serviceRemoved = true;
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
  return {
    network: "schrodump_targets",
    mounts: [],
    timeoutMs: 5000,
    correlationId: "corr-1",
    ...over,
  };
}

const SERVICE_SPEC: EphemeralServiceSpec = {
  image: "postgres:16-alpine",
  env: { POSTGRES_PASSWORD: "s3cret" },
  network: "schrodump_targets",
  readinessCommand: ["pg_isready"],
  port: 5432,
  correlationId: "corr-1",
  readinessTimeoutMs: 1000,
};

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

  it("ends the stdout sink and rejects when the container fails to start, so a consumer never deadlocks", async () => {
    // Regression: a missing executor image makes start() reject BEFORE stdout is wired to the sink.
    // backup-wiring's upload pipes FROM this sink and only resolves when it closes, then awaits the
    // run() result LAST — so if run() never ends the sink, the upload (and the worker) hang until the
    // job timeout instead of failing fast. run() must end the sink AND reject.
    const engine = new FakeEngine();
    engine.startFails = true;
    const sink = new PassThrough();
    const drained = new Promise<void>((resolve) => {
      sink.on("data", () => undefined);
      sink.on("end", () => resolve());
    });
    await expect(
      new DockerRunner(engine).run(DESCRIPTOR, opts({ stdout: sink })),
    ).rejects.toBeInstanceOf(SchrodumpError);
    // Resolves only because run() ended the sink; without the fix this awaits forever and the test
    // times out — the exact shape of the real hang.
    await drained;
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

describe("DockerRunner.withEphemeralService", () => {
  it("calls use with the address once ready, then removes the container", async () => {
    const engine = new FakeEngine({ readyAfter: 2 });
    const seen = await new DockerRunner(engine).withEphemeralService(
      SERVICE_SPEC,
      async (h) => h.host,
    );
    expect(seen).toBe(engine.lastServiceHost);
    expect(engine.serviceRemoved).toBe(true);
    expect(engine.execCalls).toBeGreaterThanOrEqual(2);
  });

  it("throws RUNNER_SERVICE_NOT_READY and still removes when readiness never succeeds", async () => {
    const engine = new FakeEngine({ readyAfter: Infinity });
    await expect(
      new DockerRunner(engine).withEphemeralService(
        { ...SERVICE_SPEC, readinessTimeoutMs: 50 },
        async () => "x",
      ),
    ).rejects.toMatchObject({ code: "RUNNER_SERVICE_NOT_READY" });
    expect(engine.serviceRemoved).toBe(true);
  });

  it("removes the container even when use throws", async () => {
    const engine = new FakeEngine({ readyAfter: 1 });
    await expect(
      new DockerRunner(engine).withEphemeralService(SERVICE_SPEC, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(engine.serviceRemoved).toBe(true);
  });

  it("throws RUNNER_NETWORK_MISSING and never starts a service when the network is missing", async () => {
    const engine = new FakeEngine({ readyAfter: 1 });
    engine.networkOk = false;
    await expect(
      new DockerRunner(engine).withEphemeralService(SERVICE_SPEC, async () => "x"),
    ).rejects.toMatchObject({ code: "RUNNER_NETWORK_MISSING" });
    // No container is created when the pre-flight fails — startService is never reached, so nothing
    // can leak. (The internal force-remove-on-throw inside DockerodeEngine.startService is
    // real-Docker-only; not unit-tested here.)
    expect(engine.startServiceCalled).toBe(false);
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
