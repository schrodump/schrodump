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

// Drains the microtask queue (all pending promise continuations), without waiting on any real
// timer. Used by the abort tests to let DockerRunner get past its own awaits (networkExists,
// start/startService) and register its "abort" listener before the test fires the signal —
// aborting earlier would fire the event before anything is listening, and it would be missed.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
  // Lets a test hold start() pending — e.g. to abort mid createContainer/attach/start, the async
  // gap between run()'s entry check and its abort-listener registration — then release it deterministically.
  startGate: Promise<void> | undefined;
  // Readable.from() is ALWAYS already ended, so a sink handed to run() gets ended by the pipeline no
  // matter what run() does — which makes the deadlock the abort path guards against untestable. This
  // returns a container stdout nothing ever writes to or ends, i.e. a container that outlived its
  // kill: the only shape in which the finally's endStdout backstop is observable.
  openStdout = false;

  readonly #readyAfter: number;
  execCalls = 0;
  serviceRemoved = false;
  startServiceCalled = false;
  lastServiceHost: string | undefined;

  constructor(options: FakeEngineOptions = { readyAfter: 1 }) {
    this.#readyAfter = options.readyAfter;
  }

  // Records what the runner asked for, so a test can assert the image is obtained BEFORE the
  // container is created — which is the whole point of the call.
  ensured: string[] = [];

  ensureImage(image: string): Promise<void> {
    this.ensured.push(image);
    return Promise.resolve();
  }

  async networkExists(): Promise<boolean> {
    return this.networkOk;
  }

  async start(spec: ContainerSpec): Promise<StartedContainer> {
    this.lastSpec = spec;
    if (this.startGate !== undefined) await this.startGate;
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

  it("force-kills the container and rejects with RUNNER_ABORTED when the signal aborts mid-run", async () => {
    const engine = new FakeEngine();
    engine.neverExits = true; // container.wait() never resolves — only the abort can end the race
    const controller = new AbortController();
    const p = new DockerRunner(engine).run(DESCRIPTOR, opts({ signal: controller.signal }));
    // Let the runner get past networkExists()/start() and register the abort listener before we
    // fire it — otherwise abort() (a synchronous event, not a polled flag) fires before anything
    // is listening and is missed, same as with any other EventTarget.
    await flushMicrotasks();
    controller.abort(new Error("shutdown"));
    await expect(p).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.killed).toBe(true);
    expect(engine.removed).toBe(true); // finally still reaps
  });

  it("never starts a container and still ends the stdout sink when the signal is already aborted", async () => {
    const engine = new FakeEngine();
    const controller = new AbortController();
    controller.abort(new Error("shutdown"));
    const sink = new PassThrough();
    await expect(
      new DockerRunner(engine).run(DESCRIPTOR, opts({ stdout: sink, signal: controller.signal })),
    ).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.started).toBe(false);
    expect(sink.writableEnded).toBe(true); // endStdout unblocked any downstream consumer
  });

  it("rejects with RUNNER_ABORTED, not a timeout, when the signal aborts while the container is still being created", async () => {
    // Repro for the lost-abort race: run()'s only synchronous "already aborted" check runs at entry,
    // before networkExists()/start() are awaited. AbortController#abort() dispatches its event
    // synchronously to whatever listeners exist at that instant — none do yet during this gap — so an
    // abort landing here must be caught some other way (a re-check right before addEventListener), or
    // it is lost forever and run() only ever ends via the timeoutMs backstop.
    const engine = new FakeEngine();
    engine.neverExits = true; // container.wait() never resolves — only the abort can end the race
    let releaseStart = (): void => undefined;
    engine.startGate = new Promise((resolve) => {
      releaseStart = resolve;
    });
    const controller = new AbortController();
    const p = new DockerRunner(engine).run(
      DESCRIPTOR,
      opts({ timeoutMs: 30, signal: controller.signal }),
    );
    // engine.start() is now pending on the gate: run() has not reached signal.addEventListener yet.
    // Abort now (the event has nowhere to land), then release start() — mirrors the real gap between
    // engine.start() returning and the abort listener being registered.
    controller.abort(new Error("shutdown"));
    releaseStart();
    await expect(p).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.killed).toBe(true);
    expect(engine.removed).toBe(true); // finally still reaps
  });

  it("ends the caller's stdout sink on abort even when the container outlives its kill", async () => {
    // The deadlock this guards: normally killing the container makes the daemon end the attach
    // stream, which ends the sink through run()'s pipeline. If the kill or the removal fails while
    // the container survives, nothing else ever ends it — and the backup upload piping FROM this
    // sink waits forever on a stream that will never close.
    const engine = new FakeEngine();
    engine.openStdout = true;
    engine.neverExits = true;
    const sink = new PassThrough();
    const controller = new AbortController();

    const promise = new DockerRunner(engine).run(
      DESCRIPTOR,
      opts({ signal: controller.signal, stdout: sink }),
    );
    await flushMicrotasks();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(sink.writableEnded).toBe(true);
  });

  it("does not double-end a sink the pipeline already closed", async () => {
    // The finally's backstop runs on every path, success included. endStdout must no-op there:
    // .end() on a finished writable emits ERR_STREAM_ALREADY_FINISHED as an 'error' event, which
    // nothing here is listening for, so an unhandled one would take the process down.
    const engine = new FakeEngine();
    engine.stdoutChunks = [Buffer.from("dump")];
    const sink = new PassThrough();
    const errors: unknown[] = [];
    sink.on("error", (err) => errors.push(err));

    const result = await new DockerRunner(engine).run(DESCRIPTOR, opts({ stdout: sink }));

    expect(result.exitCode).toBe(0);
    expect(sink.writableEnded).toBe(true);
    expect(errors).toEqual([]);
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

  it("tears the service down when the signal aborts during readiness polling", async () => {
    const engine = new FakeEngine({ readyAfter: Infinity }); // never becomes ready on its own
    const controller = new AbortController();
    const p = new DockerRunner(engine).withEphemeralService(SERVICE_SPEC, async () => "unused", {
      signal: controller.signal,
    });
    // Flush past startService() so the service is already up (and thus in the finally's
    // cleanup path) before we abort — mirrors the run() test's reasoning above.
    await flushMicrotasks();
    controller.abort(new Error("shutdown"));
    await expect(p).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
    expect(engine.serviceRemoved).toBe(true);
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

// Nothing pulled executor images. dockerode's createContainer does not, and neither did the server
// or the entrypoint — so on a fresh host the FIRST backup of every engine failed with an opaque
// "docker run failed", and the operator could not reliably pre-pull because the tag is derived from
// the server version Schrodump is about to probe (mariadb:11.8, mongo:8). Observed on the shipped
// deployment: postgres and mongo only worked because those images happened to be on the host.
describe("obtaining the executor image", () => {
  it("obtains the image before creating the container", async () => {
    const engine = new FakeEngine();
    const runner = new DockerRunner(engine);

    await runner.run(DESCRIPTOR, opts());

    expect(engine.ensured).toEqual([DESCRIPTOR.image]);
  });

  it("obtains the sandbox image before starting an ephemeral service", async () => {
    const engine = new FakeEngine();
    const runner = new DockerRunner(engine);

    await runner.withEphemeralService(SERVICE_SPEC, () => Promise.resolve("done"));

    expect(engine.ensured).toContain(SERVICE_SPEC.image);
  });

  it("fails with the image named, not with a generic run failure", async () => {
    const engine = new FakeEngine();
    engine.ensureImage = () => Promise.reject(new Error("manifest unknown"));
    const runner = new DockerRunner(engine);

    // "docker run failed" sent an operator looking at the container; the image is the thing they
    // can act on, and on a fresh host it is the overwhelmingly likely cause.
    await expect(runner.run(DESCRIPTOR, opts())).rejects.toThrow(
      /could not obtain the executor image/,
    );
  });
});
