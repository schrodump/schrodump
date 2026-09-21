// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { SchrodumpError } from "@schrodump/core/errors";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import {
  DockerRunner,
  createDockerRunner,
  demuxInto,
  executorCreateOptions,
  sanitizeStderr,
  serviceCreateOptions,
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
    // can leak. (The force-remove-on-throw inside DockerodeEngine.startService is covered against a
    // fake daemon under "removal takes the container's anonymous volumes with it", below.)
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

// The defect these cover cost a production host its whole disk. An executor's stdout is the dump
// itself, and Docker's default json-file driver has no size limit — so every byte streaming to
// object storage was ALSO written to /var/lib/docker/containers/<id>/<id>-json.log and kept, since
// these containers are deliberately created with AutoRemove: false. A 216 GB host reached 100%
// during a single MongoDB dump, with the database being protected on the same disk.
//
// Nothing could see it. The engine that calls createContainer is not exported and every unit test
// here replaces it with a fake, so the options the daemon actually receives were unobserved for
// every release so far. That is why these are pure functions now.
describe("container create options", () => {
  const spec: ContainerSpec = {
    image: "postgres:16-alpine",
    command: ["pg_dump", "-Fc"],
    env: { PGPASSWORD: "x" },
    network: "targets",
    mounts: [{ source: "/scratch/a", target: "/work", readOnly: false }],
  };

  it("gives an executor NO log driver, because its stdout is the artifact and not diagnostics", () => {
    expect(executorCreateOptions(spec).HostConfig?.LogConfig).toEqual({ Type: "none", Config: {} });
  });

  it("still carries everything the run depends on", () => {
    const opts = executorCreateOptions({ ...spec, workdir: "/work" });

    expect(opts.Image).toBe("postgres:16-alpine");
    expect(opts.Cmd).toEqual(["pg_dump", "-Fc"]);
    expect(opts.Env).toEqual(["PGPASSWORD=x"]);
    expect(opts.WorkingDir).toBe("/work");
    // Attach is how stdout is read at all, and it happens before start — turning the log driver off
    // is only safe because of that.
    expect(opts.AttachStdout).toBe(true);
    expect(opts.AttachStderr).toBe(true);
    expect(opts.HostConfig?.NetworkMode).toBe("targets");
    expect(opts.HostConfig?.Binds).toEqual(["/scratch/a:/work"]);
    // Removed by hand in run()'s finally, after the exit code and stderr have been read.
    expect(opts.HostConfig?.AutoRemove).toBe(false);
  });

  it("omits WorkingDir when the descriptor does not ask for one", () => {
    expect(executorCreateOptions(spec).WorkingDir).toBeUndefined();
  });

  it("marks a read-only mount, which is the only thing separating it from a writable bind", () => {
    const opts = executorCreateOptions({
      ...spec,
      mounts: [{ source: "/scratch/a", target: "/work", readOnly: true }],
    });

    expect(opts.HostConfig?.Binds).toEqual(["/scratch/a:/work:ro"]);
  });

  it("CAPS the sandbox's log rather than discarding it — that output is the reason it failed", () => {
    // The opposite case on purpose. A throwaway database server's log is diagnostics, bounded by
    // its own verbosity rather than by the size of the data, and "the sandbox could not run" is the
    // hardest failure this product has to explain. Discarding it would trade a disk problem for a
    // blindness problem.
    const svc: EphemeralServiceSpec = {
      image: "postgres:16-alpine",
      env: { POSTGRES_PASSWORD: "x" },
      network: "targets",
      readinessCommand: ["pg_isready"],
      port: 5432,
      correlationId: "c",
      readinessTimeoutMs: 1000,
    };
    const log = serviceCreateOptions(svc).HostConfig?.LogConfig;

    expect(log?.Type).toBe("json-file");
    expect(log?.Config).toEqual({ "max-size": "10m", "max-file": "1" });
  });
});

// The slice of dockerode the real engine calls, faked. FakeEngine above replaces the engine
// wholesale, so it can only ever say THAT a container was removed — never with which options. The
// defect below lived in exactly that gap, so these tests drive the real engine, through
// createDockerRunner, against a daemon that records what every removal carried.
interface FakeDaemonContainer {
  readonly removals: unknown[];
}

class FakeDaemon {
  readonly created: FakeDaemonContainer[] = [];
  // The executor's process: exits by itself with statusCode, or runs until it is killed.
  exitsByItself = true;
  statusCode = 0;
  // A start the daemon refuses AFTER the create succeeded — the container, and its anonymous
  // volume, already exist by then.
  startFails = false;
  // What the sandbox's readiness probe exits with; anything but 0 means "not ready yet".
  readinessExitCode = 0;

  getNetwork(): { inspect(): Promise<unknown> } {
    return { inspect: () => Promise.resolve({}) };
  }

  getImage(): { inspect(): Promise<unknown> } {
    return { inspect: () => Promise.resolve({}) };
  }

  createContainer(options: Docker.ContainerCreateOptions): Promise<unknown> {
    const record: FakeDaemonContainer = { removals: [] };
    this.created.push(record);
    const attach = new PassThrough();
    let exit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    // The process ending closes the attach, which is what ends the executor's stdout in start().
    const stop = (code: number): void => {
      if (!attach.writableEnded) attach.end();
      exit(code);
    };
    const network = options.HostConfig?.NetworkMode ?? "";

    return Promise.resolve({
      modem: {
        demuxStream(source: NodeJS.ReadableStream, out: Writable) {
          source.on("data", (chunk: Buffer) => out.write(chunk));
        },
      },
      attach: () => Promise.resolve(attach),
      start: () => {
        if (this.startFails) return Promise.reject(new Error("bind source path does not exist"));
        if (this.exitsByItself) stop(this.statusCode);
        return Promise.resolve();
      },
      wait: async () => ({ StatusCode: await exited }),
      kill: () => {
        stop(137);
        return Promise.resolve();
      },
      inspect: () =>
        Promise.resolve({
          Name: "/sandbox",
          NetworkSettings: { Networks: { [network]: { IPAddress: "172.18.0.9" } } },
        }),
      exec: () =>
        Promise.resolve({
          start: () => Promise.resolve(Readable.from([])),
          inspect: () => Promise.resolve({ ExitCode: this.readinessExitCode }),
        }),
      remove: (removeOptions?: unknown) => {
        record.removals.push(removeOptions);
        stop(137);
        return Promise.resolve();
      },
    });
  }
}

function runnerOn(daemon: FakeDaemon): DockerRunner {
  return createDockerRunner(daemon as unknown as Docker);
}

// Observed on a live stack: after three FULL_RESTORE verifies, three dangling Docker volumes, each a
// complete PostgreSQL data directory — pg_wal, postgresql.conf, postmaster.pid — in clear under
// /var/lib/docker/volumes, and nothing that would ever delete them. The stock engine images declare
// a VOLUME for their data directory, nothing is mounted over it, so Docker creates an anonymous
// volume with the container; `remove({ force: true })` stops the container and leaves the volume.
// For the sandbox that volume is the restored database. A daily verify of a 50 GB database fills
// the host in days, and every verified backup also existed unencrypted on it.
//
// The expectation is written out literally rather than imported: asserting against the exported
// constant would stay green with `v` deleted from it, which is the one mutation that matters.
describe("removal takes the container's anonymous volumes with it", () => {
  const WITH_ITS_VOLUMES = { force: true, v: true };

  function removedWithItsVolumes(daemon: FakeDaemon): void {
    expect(daemon.created).toHaveLength(1);
    expect(daemon.created[0]?.removals).toEqual([WITH_ITS_VOLUMES]);
  }

  describe("an executor", () => {
    it("after a clean exit", async () => {
      const daemon = new FakeDaemon();

      const result = await runnerOn(daemon).run(DESCRIPTOR, opts());

      expect(result.exitCode).toBe(0);
      removedWithItsVolumes(daemon);
    });

    it("when the dump or restore it ran failed", async () => {
      const daemon = new FakeDaemon();
      daemon.statusCode = 1;

      const result = await runnerOn(daemon).run(DESCRIPTOR, opts());

      expect(result.exitCode).toBe(1);
      removedWithItsVolumes(daemon);
    });

    it("when the run times out", async () => {
      const daemon = new FakeDaemon();
      daemon.exitsByItself = false;

      await expect(runnerOn(daemon).run(DESCRIPTOR, opts({ timeoutMs: 30 }))).rejects.toMatchObject(
        { code: "RUNNER_TIMEOUT" },
      );
      removedWithItsVolumes(daemon);
    });

    it("when the run is aborted by shutdown", async () => {
      const daemon = new FakeDaemon();
      daemon.exitsByItself = false;
      const controller = new AbortController();

      const run = runnerOn(daemon).run(DESCRIPTOR, opts({ signal: controller.signal }));
      await flushMicrotasks();
      controller.abort(new Error("shutdown"));

      await expect(run).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
      removedWithItsVolumes(daemon);
    });

    it("when the daemon created it but refused to start it", async () => {
      // run() only gets a handle to remove on the return path, so this one has to be reaped inside
      // the engine — and until this fix it was not reaped at all.
      const daemon = new FakeDaemon();
      daemon.startFails = true;

      await expect(runnerOn(daemon).run(DESCRIPTOR, opts())).rejects.toMatchObject({
        code: "RUNNER_FAILED",
      });
      removedWithItsVolumes(daemon);
    });
  });

  describe("a verify sandbox", () => {
    it("after the restore it hosted", async () => {
      const daemon = new FakeDaemon();

      const host = await runnerOn(daemon).withEphemeralService(SERVICE_SPEC, async (h) => h.host);

      expect(host).toBe("172.18.0.9");
      removedWithItsVolumes(daemon);
    });

    it("when the restore inside it failed", async () => {
      const daemon = new FakeDaemon();

      await expect(
        runnerOn(daemon).withEphemeralService(SERVICE_SPEC, () =>
          Promise.reject(new Error("pg_restore: error: could not execute query")),
        ),
      ).rejects.toThrow("pg_restore");
      removedWithItsVolumes(daemon);
    });

    it("when it never became ready", async () => {
      const daemon = new FakeDaemon();
      daemon.readinessExitCode = 1;

      await expect(
        runnerOn(daemon).withEphemeralService({ ...SERVICE_SPEC, readinessTimeoutMs: 50 }, () =>
          Promise.resolve("unused"),
        ),
      ).rejects.toMatchObject({ code: "RUNNER_SERVICE_NOT_READY" });
      removedWithItsVolumes(daemon);
    });

    it("when the verify is aborted by shutdown", async () => {
      const daemon = new FakeDaemon();
      daemon.readinessExitCode = 1; // never ready on its own — only the abort ends it
      const controller = new AbortController();

      const verify = runnerOn(daemon).withEphemeralService(
        SERVICE_SPEC,
        () => Promise.resolve("unused"),
        { signal: controller.signal },
      );
      await flushMicrotasks();
      controller.abort(new Error("shutdown"));

      await expect(verify).rejects.toMatchObject({ code: "RUNNER_ABORTED" });
      removedWithItsVolumes(daemon);
    });

    it("when the daemon created it but refused to start it", async () => {
      const daemon = new FakeDaemon();
      daemon.startFails = true;

      await expect(
        runnerOn(daemon).withEphemeralService(SERVICE_SPEC, () => Promise.resolve("unused")),
      ).rejects.toThrow("bind source path does not exist");
      removedWithItsVolumes(daemon);
    });
  });
});

// Measured on a production MongoDB: 46 GB read from the database, 1.4 GB uploaded to object
// storage, and the server holding 74 GiB of a 125 GiB host. The dump was not going to disk — it
// was queued in memory, because nothing between the socket and the uploader ever said "stop".
describe("backpressure reaches the container", () => {
  // dockerode's shape, and the whole problem in three lines: a flowing-mode listener, and a write
  // whose return value is discarded. Reproduced rather than described, so the test fails for the
  // real reason if docker-modem ever changes.
  const modemLikeDockerode = {
    demuxStream(source: NodeJS.ReadableStream, out: Writable) {
      source.on("data", (chunk: Buffer) => {
        out.write(chunk);
      });
    },
  };

  function offeredSource(chunks: number, size: number) {
    const state = { produced: 0 };
    const chunk = Buffer.alloc(size, 1);
    let left = chunks;
    const stream = new Readable({
      read() {
        if (left === 0) {
          this.push(null);
          return;
        }
        left -= 1;
        state.produced += size;
        this.push(chunk);
      },
    });
    return { stream, state };
  }

  const CHUNK = 64 * 1024;
  const OFFERED = 400; // ~26 MB, far past any reasonable buffer

  it("stops pulling from the socket while nothing is reading stdout", async () => {
    const src = offeredSource(OFFERED, CHUNK);
    const stdout = new PassThrough({ highWaterMark: CHUNK });

    demuxInto(modemLikeDockerode, src.stream, stdout, new PassThrough());
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(src.state.produced).toBeLessThan(OFFERED * CHUNK);
  });

  it("resumes once the consumer drains, so a slow reader is slow and not broken", async () => {
    // The consumer has to be slow enough to actually FILL the destination, or the pause never
    // fires and this asserts nothing — the first version of this test passed with `resume`
    // deleted, which is the only reason it is written this way.
    const src = offeredSource(60, CHUNK);
    const stdout = new PassThrough({ highWaterMark: CHUNK });
    let received = 0;
    const slow = new Writable({
      highWaterMark: CHUNK,
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        setTimeout(callback, 1);
      },
    });

    demuxInto(modemLikeDockerode, src.stream, stdout, new PassThrough());
    // What `attachStream.on("end")` does in start(): the socket closing is what ends stdout.
    src.stream.on("end", () => stdout.end());
    await pipeline(stdout, slow);

    // Without the resume the chain stalls at the first full buffer and this never arrives.
    expect(received).toBe(60 * CHUNK);
  }, 10_000);

  it("without the sink, the same modem queues everything — which is the defect", async () => {
    // The control. Handing demuxStream the PassThrough directly is what the runner used to do, and
    // it is what makes the two tests above mean something: the bound comes from the sink, not from
    // the streams happening to be slow.
    const src = offeredSource(OFFERED, CHUNK);
    const stdout = new PassThrough({ highWaterMark: CHUNK });

    modemLikeDockerode.demuxStream(src.stream, stdout);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(src.state.produced).toBe(OFFERED * CHUNK);
    expect(stdout.writableLength).toBeGreaterThan(CHUNK);
  });
});
