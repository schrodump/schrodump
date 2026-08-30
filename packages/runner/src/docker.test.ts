// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { PassThrough, Readable, Writable } from "node:stream";
import { getEventListeners } from "node:events";
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
  // Return an OPEN stdout that nothing ever writes to and nothing ever ends, instead of the default
  // already-ended `Readable.from(chunks)`. That is what a real attach stream looks like while the
  // container is still alive: the daemon is the one that ends it, when the container dies. Needed to
  // reach the deadlock class where the daemon does NOT do that (a removal that fails fast while the
  // container survives) — with an always-ended stdout no test can express it.
  openStdout = false;
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
      stdout: this.openStdout ? new PassThrough() : Readable.from(this.stdoutChunks),
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

  it("kills the container and rejects RUNNER_ABORTED when the signal aborts mid-run", async () => {
    const engine = new FakeEngine();
    engine.neverExits = true; // the dump is still running when the signal arrives
    const controller = new AbortController();
    const promise = new DockerRunner(engine).run(DESCRIPTOR, opts({ signal: controller.signal }));
    // Let run() get past networkExists + start and register its abort listener.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.killed).toBe(true);
    expect(engine.removed).toBe(true);
  });

  it("never starts a container and ends the stdout sink when the signal is already aborted", async () => {
    const engine = new FakeEngine();
    const sink = new PassThrough();
    await expect(
      new DockerRunner(engine).run(DESCRIPTOR, opts({ signal: AbortSignal.abort(), stdout: sink })),
    ).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.started).toBe(false);
    // `.end()` sets writableEnded synchronously; 'finish' is emitted later through the Writable's
    // own nextTick chain, so the event is not observable yet at this point. What matters to the
    // caller is that the sink was ended — a consumer piping FROM it sees EOF and unblocks.
    expect(sink.writableEnded).toBe(true);
  });

  it("ends the stdout sink on a mid-run abort, even when the container's stdout stays open", async () => {
    // Every other failure path in run() ends opts.stdout explicitly; the mid-run abort relied on the
    // Docker daemon ending the attach stream when the killed container dies. If removal fails fast
    // while the container survives (a daemon 500, a socket-proxy denial), nothing ends the sink —
    // backup-wiring's upload pipes FROM it and never settles, so whenIdle() never resolves. That is
    // the exact deadlock class endStdout exists to prevent, so run()'s finally must end it too.
    const engine = new FakeEngine();
    engine.openStdout = true; // the attach stream the daemon never ended
    engine.neverExits = true;
    const sink = new PassThrough();
    const controller = new AbortController();
    const promise = new DockerRunner(engine).run(
      DESCRIPTOR,
      opts({ signal: controller.signal, stdout: sink }),
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    // Ended by run() itself, not by the pipeline: nothing else ever will.
    expect(sink.writableEnded).toBe(true);
  });

  it("removes its abort listener once the run settles, so a long-lived signal never accumulates them", async () => {
    const engine = new FakeEngine();
    engine.stdoutChunks = [Buffer.from("dump")];
    const controller = new AbortController();
    const runner = new DockerRunner(engine);
    await runner.run(DESCRIPTOR, opts({ signal: controller.signal }));
    await runner.run(DESCRIPTOR, opts({ signal: controller.signal }));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("still cancels when the signal fires while the container is being started", async () => {
    const engine = new FakeEngine();
    engine.neverExits = true;
    const controller = new AbortController();
    // Abort in the middle of start() — after run()'s entry check, before its listener exists.
    const started = engine.start.bind(engine);
    engine.start = async (spec) => {
      controller.abort();
      return started(spec);
    };
    await expect(
      new DockerRunner(engine).run(DESCRIPTOR, opts({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.killed).toBe(true);
    expect(engine.removed).toBe(true);
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

  it("rejects RUNNER_ABORTED and removes the service when the signal aborts during use", async () => {
    const engine = new FakeEngine({ readyAfter: 1 });
    const controller = new AbortController();
    const promise = new DockerRunner(engine).withEphemeralService(
      SERVICE_SPEC,
      () => new Promise<string>(() => undefined), // a restore that never finishes on its own
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.serviceRemoved).toBe(true);
  });

  it("never creates a service when the signal is already aborted", async () => {
    const engine = new FakeEngine({ readyAfter: 1 });
    await expect(
      new DockerRunner(engine).withEphemeralService(SERVICE_SPEC, async () => "x", {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.startServiceCalled).toBe(false);
  });

  it("aborts while readiness is still being polled, without waiting out readinessTimeoutMs", async () => {
    const engine = new FakeEngine({ readyAfter: Infinity }); // never becomes ready
    const controller = new AbortController();
    const promise = new DockerRunner(engine).withEphemeralService(
      { ...SERVICE_SPEC, readinessTimeoutMs: 60_000 },
      async () => "x",
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.serviceRemoved).toBe(true);
  });

  it("still cancels when the signal fires while the service is being started", async () => {
    const engine = new FakeEngine({ readyAfter: 1 });
    const controller = new AbortController();
    const startedService = engine.startService.bind(engine);
    engine.startService = async (spec) => {
      controller.abort();
      return startedService(spec);
    };
    await expect(
      new DockerRunner(engine).withEphemeralService(SERVICE_SPEC, async () => "x", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.serviceRemoved).toBe(true);
  });

  it("does not remove the service until the aborted use callback has unwound", async () => {
    // Before the fix the race rejected and the finally tore the sandbox down while `guarded` — the
    // readiness poll plus the whole `use` callback, a full restore for verify — was still running.
    // The inner cleanup was then detached: whenIdle() could resolve, and the process exit, with a
    // cleartext dump's rm still pending. The teardown must follow the unwind, not race it.
    const engine = new FakeEngine({ readyAfter: 1 });
    const controller = new AbortController();
    const order: string[] = [];
    let unwind: (() => void) | undefined;

    const promise = new DockerRunner(engine).withEphemeralService(
      SERVICE_SPEC,
      () =>
        new Promise<string>((_resolve, reject) => {
          // Stands in for a restore that observes the same signal and then runs its own cleanup:
          // it settles only when we say so, so the ordering below is deterministic.
          unwind = () => {
            order.push("use-unwound");
            reject(new Error("restore aborted, its scratch released"));
          };
        }),
      { signal: controller.signal },
    );
    // Let readiness pass and `use` be entered before aborting.
    while (unwind === undefined) await new Promise((r) => setTimeout(r, 1));
    controller.abort();

    // The race has already rejected by now, but the sandbox must still be up: its inner work has
    // not unwound yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.serviceRemoved).toBe(false);

    unwind();
    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    order.push("service-removed");
    expect(engine.serviceRemoved).toBe(true);
    expect(order).toEqual(["use-unwound", "service-removed"]);
  });

  it("gives up on a wedged use callback after the unwind bound, rather than holding the shutdown open", async () => {
    // The other half of the same fix: the wait must be bounded. A `use` that never settles is a
    // worse outcome than the detached cleanup — it would hold the process past the docker-stop
    // window and trade an abort for a SIGKILL. The service is still removed.
    const engine = new FakeEngine({ readyAfter: 1 });
    const controller = new AbortController();
    const promise = new DockerRunner(engine).withEphemeralService(
      SERVICE_SPEC,
      () => new Promise<string>(() => undefined), // never settles, not even on abort
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.serviceRemoved).toBe(true);
  });

  it("removes its abort listener once the call settles, so a long-lived signal never accumulates them", async () => {
    const engine = new FakeEngine({ readyAfter: 1 });
    const controller = new AbortController();
    const runner = new DockerRunner(engine);
    await runner.withEphemeralService(SERVICE_SPEC, async () => "x", { signal: controller.signal });
    await runner.withEphemeralService(SERVICE_SPEC, async () => "x", { signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
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
