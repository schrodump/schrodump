// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { PassThrough, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Docker from "dockerode";
import { SchrodumpError } from "@schrodump/core/errors";
import type { ExecutionDescriptor } from "@schrodump/core/execution";
import type {
  EphemeralServiceHandle,
  EphemeralServiceSpec,
  RunOptions,
  RunResult,
  Runner,
} from "./runner.js";

export type { EphemeralServiceHandle, EphemeralServiceSpec } from "./runner.js";

const STDERR_LIMIT_BYTES = 8 * 1024;
// How often withEphemeralService polls readinessCommand while waiting for the service to come up.
const SERVICE_READINESS_POLL_MS = 250;

export interface ContainerSpec {
  readonly image: string;
  readonly command: string[];
  readonly env: Record<string, string>;
  readonly network: string;
  readonly mounts: readonly { source: string; target: string; readOnly: boolean }[];
  readonly workdir?: string;
}

// The Docker surface DockerRunner depends on. A real dockerode-backed impl (DockerodeEngine)
// and a fake (in tests) both satisfy it, so the exit-code / timeout / cleanup logic is unit
// tested without a Docker daemon.
export interface StartedContainer {
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<number>; // container StatusCode
  kill(): Promise<void>;
  remove(): Promise<void>;
}

// A running ephemeral SERVICE container (as opposed to StartedContainer's one-shot exit-and-remove
// shape): still up, reachable at `host`, and probed via `exec` until ready.
export interface StartedService {
  readonly host: string; // in-network address of the container
  exec(command: string[]): Promise<number>; // runs command in the container, returns exit code
  remove(): Promise<void>; // force-remove
}

export interface DockerEngine {
  networkExists(name: string): Promise<boolean>;
  start(spec: ContainerSpec): Promise<StartedContainer>;
  startService(spec: EphemeralServiceSpec): Promise<StartedService>;
}

export class DockerRunner implements Runner {
  readonly #engine: DockerEngine;

  constructor(engine: DockerEngine) {
    this.#engine = engine;
  }

  async run(descriptor: ExecutionDescriptor, opts: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();

    if (opts.signal?.aborted === true) {
      endStdout(opts.stdout);
      throw abortedError(opts.correlationId);
    }

    // Fail clearly on a missing network — never fall back to the default network.
    if (!(await this.#engine.networkExists(opts.network))) {
      // End the caller's stdout sink first: a consumer piping FROM it (backup-wiring's upload reads
      // container stdout -> gzip -> encrypt -> S3) blocks until the stream closes, and nothing will
      // ever be written to it now. Without this the upload deadlocks and the real error below never
      // surfaces — see endStdout's note. On the success path the stdout pipeline ends it instead.
      endStdout(opts.stdout);
      throw new SchrodumpError(`docker network "${opts.network}" does not exist`, {
        code: "RUNNER_NETWORK_MISSING",
        correlationId: opts.correlationId,
        context: { network: opts.network },
      });
    }

    let container: StartedContainer;
    try {
      container = await this.#engine.start({
        image: descriptor.image,
        command: descriptor.command,
        env: descriptor.env,
        network: opts.network,
        mounts: opts.mounts,
        ...(descriptor.workdir !== undefined ? { workdir: descriptor.workdir } : {}),
      });
    } catch (err) {
      // createContainer/attach/start failed BEFORE the container's stdout was ever wired to
      // opts.stdout — most commonly the executor image is not present locally (dockerode does not
      // pull, so createContainer returns 404 "No such image"). End the caller's stdout sink so a
      // consumer piping from it unblocks (otherwise the backup upload waits forever on a dump stream
      // that never arrives — a worker hang bounded only by the job timeout), then surface the failure.
      endStdout(opts.stdout);
      throw new SchrodumpError("docker run failed", {
        code: "RUNNER_FAILED",
        correlationId: opts.correlationId,
        context: {},
        cause: err,
      });
    }

    const stderr = captureStderr(container.stderr, STDERR_LIMIT_BYTES);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    try {
      const stdoutDone =
        opts.stdout !== undefined
          ? pipeline(container.stdout, opts.stdout)
          : drain(container.stdout);

      const execution = (async () => {
        // Success is decided ONLY by StatusCode — never by the stdout stream reaching EOF.
        const [, statusCode] = await Promise.all([stdoutDone, container.wait()]);
        return statusCode;
      })();
      execution.catch(() => undefined); // swallow a late rejection if the timeout wins the race

      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void container.kill().catch(() => undefined);
          reject(
            new SchrodumpError("run exceeded its timeout", {
              code: "RUNNER_TIMEOUT",
              correlationId: opts.correlationId,
              context: { timeoutMs: opts.timeoutMs },
            }),
          );
        }, opts.timeoutMs);
      });

      const aborted = new Promise<never>((_resolve, reject) => {
        const signal = opts.signal;
        if (signal === undefined) return; // never settles → never wins the race
        onAbort = () => {
          // Same teardown the timeout uses: kill now; the finally below force-removes.
          void container.kill().catch(() => undefined);
          reject(abortedError(opts.correlationId));
        };
        // The entry check above can be stale: abort may have fired during networkExists()/start()
        // (the async gap before this listener exists). abort() dispatches synchronously to
        // listeners present at that instant, so a gap-window abort is lost to a listener added now
        // — catch it here instead of leaving run() to hang until timeoutMs.
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });

      const exitCode = await Promise.race([execution, timeout, aborted]);

      return {
        exitCode,
        stderr: sanitizeStderr(stderr.text(), descriptor.env),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (err instanceof SchrodumpError) throw err;
      throw new SchrodumpError("docker run failed", {
        code: "RUNNER_FAILED",
        correlationId: opts.correlationId,
        context: {},
        cause: err,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) opts.signal?.removeEventListener("abort", onAbort);
      // Manual removal (never AutoRemove) so exit code and stderr are read first.
      await container.remove().catch(() => undefined);
    }
  }

  async withEphemeralService<T>(
    spec: EphemeralServiceSpec,
    use: (handle: EphemeralServiceHandle) => Promise<T>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<T> {
    // Pre-flight the network exactly as run() does, and BEFORE startService — a missing network makes
    // container.start() throw AFTER createContainer already succeeded, orphaning the container we'd
    // never get a handle to remove. Failing here means no container is created in that case.
    if (!(await this.#engine.networkExists(spec.network))) {
      throw new SchrodumpError(`docker network "${spec.network}" does not exist`, {
        code: "RUNNER_NETWORK_MISSING",
        correlationId: spec.correlationId,
        context: { network: spec.network },
      });
    }

    if (opts?.signal?.aborted === true) {
      throw abortedError(spec.correlationId);
    }

    const svc = await this.#engine.startService(spec);

    try {
      await this.#waitUntilReady(svc, spec, opts?.signal);
      return await use({ host: svc.host, port: spec.port });
    } finally {
      // Manual removal (never AutoRemove), mirroring run(): always torn down, even if `use` threw
      // or readiness never arrived.
      await svc.remove().catch(() => undefined);
    }
  }

  async #waitUntilReady(
    svc: StartedService,
    spec: EphemeralServiceSpec,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + spec.readinessTimeoutMs;
    for (;;) {
      if (signal?.aborted === true) throw abortedError(spec.correlationId);
      const exitCode = await svc.exec(spec.readinessCommand);
      if (exitCode === 0) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new SchrodumpError("service did not become ready", {
          code: "RUNNER_SERVICE_NOT_READY",
          correlationId: spec.correlationId,
          context: { image: spec.image },
        });
      }
      // Cap the wait to whatever's left of readinessTimeoutMs, so the timeout fires on time
      // instead of overshooting by up to one full poll interval.
      await sleep(Math.min(SERVICE_READINESS_POLL_MS, remainingMs));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortedError(correlationId: string): SchrodumpError {
  return new SchrodumpError("run aborted by shutdown", {
    code: "RUNNER_ABORTED",
    correlationId,
    context: {},
  });
}

// End the caller's stdout sink so a consumer piping FROM it sees EOF and unblocks. Called only on
// the paths where run() fails BEFORE the container's stdout is wired to it (missing network, a
// createContainer that 404s on an absent image); the success/execution paths end it through their
// own `pipeline(container.stdout, opts.stdout)`. `.end()` (clean EOF), never `.destroy(err)`: Node's
// `.pipe()` does not forward a source error to its destination, so destroying the sink would strand
// the consumer's own gzip/encrypt pipeline waiting on a stream that never closes — the very deadlock
// this prevents. A clean end lets that pipeline drain; the run() rejection is what the caller then
// observes. Guarded because a sink already torn down would throw.
function endStdout(stdout: Writable | undefined): void {
  if (stdout === undefined) return;
  try {
    stdout.end();
  } catch {
    // Already ended/destroyed — nothing to unblock.
  }
}

export function createDockerRunner(docker?: Docker): DockerRunner {
  return new DockerRunner(new DockerodeEngine(docker ?? dockerFromEnv()));
}

// DB client errors frequently echo host, user and sometimes the password. Redact before the
// stderr is persisted or logged.
const CREDENTIAL_KEY = /pass|pwd|secret|token/i;
const REDACTED = "[redacted]";

export function sanitizeStderr(raw: string, env: Record<string, string>): string {
  let out = raw;
  // The runner is handed descriptor.env, so it knows the exact secret values — redact them.
  for (const [key, value] of Object.entries(env)) {
    if (value.length >= 3 && CREDENTIAL_KEY.test(key)) {
      out = out.split(value).join(REDACTED);
    }
  }
  // Credentials embedded in a connection URI: scheme://user:pass@host
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi, `$1${REDACTED}:${REDACTED}@`);
  // password=... / password: ... option style
  out = out.replace(/\b(password|pwd)\s*[=:]\s*\S+/gi, `$1=${REDACTED}`);
  return out;
}

function captureStderr(stderr: Readable, limit: number): { text: () => string } {
  const chunks: Buffer[] = [];
  let total = 0;
  stderr.on("data", (chunk: Buffer) => {
    if (total >= limit) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buf);
    total += buf.length;
  });
  stderr.on("error", () => undefined);
  return { text: () => Buffer.concat(chunks).toString("utf8").slice(0, limit) };
}

function drain(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("data", () => undefined);
    stream.on("end", () => resolve());
    stream.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

class DockerodeEngine implements DockerEngine {
  readonly #docker: Docker;

  constructor(docker: Docker) {
    this.#docker = docker;
  }

  async networkExists(name: string): Promise<boolean> {
    try {
      await this.#docker.getNetwork(name).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async start(spec: ContainerSpec): Promise<StartedContainer> {
    const createOptions: Docker.ContainerCreateOptions = {
      Image: spec.image,
      Cmd: spec.command,
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        NetworkMode: spec.network,
        AutoRemove: false,
        Binds: spec.mounts.map((m) => `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`),
      },
      ...(spec.workdir !== undefined ? { WorkingDir: spec.workdir } : {}),
    };

    const container = await this.#docker.createContainer(createOptions);
    // Read-only attach: stdout/stderr only, no stdin. Feeding a container's stdin needs a hijacked
    // attach whose demux intermittently leaks attach-protocol framing into the stdout stream —
    // corrupting it. No executor needs stdin (dumps read from the DB, restores read a mounted file).
    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    container.modem.demuxStream(attachStream, stdout, stderr);
    attachStream.on("end", () => {
      stdout.end();
      stderr.end();
    });

    await container.start();

    return {
      stdout,
      stderr,
      wait: async () => {
        const result = (await container.wait()) as { StatusCode: number };
        return result.StatusCode;
      },
      kill: async () => {
        await container.kill();
      },
      remove: async () => {
        await container.remove({ force: true });
      },
    };
  }

  async startService(spec: EphemeralServiceSpec): Promise<StartedService> {
    const container = await this.#docker.createContainer({
      Image: spec.image,
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      HostConfig: {
        NetworkMode: spec.network,
        AutoRemove: false,
      },
    });

    // Once createContainer succeeds the container exists and must be reaped even if start/inspect
    // throws (e.g. a start failure), otherwise it leaks — withEphemeralService only ever gets a
    // handle to remove on the RETURN path. Force-remove on throw, then rethrow the original error.
    let info: Docker.ContainerInspectInfo;
    try {
      await container.start();
      info = await container.inspect();
    } catch (err) {
      await container.remove({ force: true }).catch(() => undefined);
      throw err;
    }

    const ipAddress = info.NetworkSettings.Networks[spec.network]?.IPAddress;
    // No IP yet (e.g. some network drivers resolve it only via DNS) — fall back to the
    // container's own name, which Docker always registers as a DNS alias on user-defined networks.
    const host =
      ipAddress !== undefined && ipAddress.length > 0 ? ipAddress : info.Name.replace(/^\//, "");

    return {
      host,
      exec: async (command: string[]) => {
        const dockerExec = await container.exec({
          Cmd: command,
          AttachStdout: true,
          AttachStderr: true,
        });
        // Read-only attach, same convention as start(): drain so the hijacked pipe never
        // backpressures the readiness probe, we don't need its output.
        const stream = await dockerExec.start({});
        await drain(stream);
        const { ExitCode } = await dockerExec.inspect();
        return ExitCode ?? 1;
      },
      remove: async () => {
        await container.remove({ force: true });
      },
    };
  }
}

function dockerFromEnv(): Docker {
  const host = process.env.DOCKER_HOST;
  if (host === undefined || host.length === 0) {
    return new Docker();
  }
  const url = new URL(host);
  if (url.protocol === "unix:") {
    return new Docker({ socketPath: url.pathname });
  }
  return new Docker({ host: url.hostname, port: Number(url.port) });
}
