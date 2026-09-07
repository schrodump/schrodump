// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The deployment's socket proxy must permit every Docker API call this package makes.
//
// It did not, and nothing noticed. compose.yaml shipped `EXEC: 0` while withEphemeralService polls
// a verify sandbox's readiness with `docker exec`, so the proxy answered 403 and FULL_RESTORE
// verify — the feature this product exists for — could not run on any deployment using the file we
// ship. The integration suite never saw it because it talks to the Docker socket DIRECTLY: the one
// component the deployment inserts between this code and Docker was never in the loop being
// tested.
//
// So this test reads the proxy's environment out of compose.yaml, starts a proxy configured
// exactly that way, and drives a real container through it with the same client the runner uses.
// A future edit that tightens the allow-list past what the runner needs fails here instead of in
// somebody's incident.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.SCHRODUMP_TEST_INTEGRATION === "1";
const PROXY_IMAGE = "tecnativa/docker-socket-proxy:v0.4.2";
const PROXY_NAME = "schrodump-socket-proxy-test";
const PORT = 12399;

// Reads the `environment:` block of the docker-proxy service. Deliberately strict: an empty result
// throws rather than yielding an empty allow-list that would let every assertion below pass for the
// wrong reason — the exact shape of failure that made the DCO check green on its own error.
function proxyEnvFromCompose(): Record<string, string> {
  const composePath = fileURLToPath(new URL("../../../compose.yaml", import.meta.url));
  const compose = readFileSync(composePath, "utf8");
  const service = compose.split(/^ {2}docker-proxy:$/m)[1];
  if (service === undefined) throw new Error("compose.yaml has no docker-proxy service");
  const block = service.split(/^ {4}volumes:$/m)[0] ?? "";
  const env: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = /^\s{6}([A-Z_]+):\s*(\d+)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) env[match[1]] = match[2];
  }
  if (Object.keys(env).length === 0) {
    throw new Error("could not parse the docker-proxy environment from compose.yaml");
  }
  return env;
}

describe.skipIf(!enabled)("the deployment's socket proxy permits what the runner calls", () => {
  let docker: Docker;

  beforeAll(() => {
    const env = proxyEnvFromCompose();
    // The parse has to have found the real block, not an empty one.
    expect(Object.keys(env).length).toBeGreaterThanOrEqual(5);
    expect(env["CONTAINERS"]).toBe("1");

    execFileSync("docker", ["rm", "-f", PROXY_NAME], { stdio: "ignore" });
    execFileSync("docker", [
      "run",
      "-d",
      "--name",
      PROXY_NAME,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "-p",
      `${String(PORT)}:2375`,
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock:ro",
      PROXY_IMAGE,
    ]);

    docker = new Docker({ host: "127.0.0.1", port: PORT });
  }, 300_000);

  afterAll(() => {
    execFileSync("docker", ["rm", "-f", PROXY_NAME], { stdio: "ignore" });
  });

  it("allows the whole container lifecycle the runner drives, exec included", async () => {
    // Waits for the proxy to answer at all; a connection error here is not an allow-list failure.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await docker.ping();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Pull — IMAGES + POST. The runner does this for every executor image.
    await new Promise<void>((resolve, reject) => {
      docker.pull("alpine:latest", (err: unknown, stream: NodeJS.ReadableStream) => {
        if (err !== null && err !== undefined) return reject(err as Error);
        docker.modem.followProgress(stream, (done: unknown) =>
          done === null || done === undefined ? resolve() : reject(done as Error),
        );
      });
    });

    // Networks — the runner pre-flights the target network before every run.
    await expect(docker.listNetworks()).resolves.toBeDefined();

    // Create, start, inspect — the shape of DockerRunner.startService.
    const container = await docker.createContainer({
      Image: "alpine:latest",
      Cmd: ["sleep", "60"],
      name: `${PROXY_NAME}-subject`,
    });
    try {
      await container.start();
      await expect(container.inspect()).resolves.toBeDefined();

      // THE REGRESSION THIS FILE EXISTS FOR. withEphemeralService polls readiness with exec; with
      // EXEC: 0 these two calls answer 403 and FULL_RESTORE verify can never come up.
      const exec = await container.exec({
        Cmd: ["true"],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({});
      await new Promise<void>((resolve) => {
        stream.on("data", () => undefined);
        stream.on("end", () => resolve());
        stream.on("error", () => resolve());
      });
      const inspected = await exec.inspect();
      expect(inspected.ExitCode).toBe(0);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }, 300_000);
});

// The allow-list is not the only thing about this proxy the runner depends on and CI could not see.
// The image bakes `timeout client 10m` / `timeout server 10m` into its HAProxy config, and both are
// fatal to a long job: a dump's `container.wait()` is a long-poll that stays silent until the
// container exits, and a `pg_restore` verify writes nothing to stdout while it restores — so an idle
// connection past ten minutes is severed, `run()` blocks on a wait() that never settles, and the
// job hangs until the 3h DUMP_TIMEOUT_MS ceiling with its executor orphaned. A 655 MB verify hung
// exactly this way in production. compose.yaml disables both timeouts (the runner owns the real
// ceiling); this proves the cut is real and that disabling it is what prevents the hang.
describe.skipIf(!enabled)("the socket proxy must not time out a long-running job", () => {
  const TINY_NAME = "schrodump-socket-proxy-tiny";
  const NOLIMIT_NAME = "schrodump-socket-proxy-nolimit";
  const TINY_PORT = 12398;
  const NOLIMIT_PORT = 12397;

  beforeAll(() => {
    // Pull the sleeper image to the host up front, so createContainer (which does not pull) finds it
    // locally — never streaming a pull through the short-timeout proxy under test, which would be a
    // flaky dependence on that pull finishing inside two seconds.
    execFileSync("docker", ["pull", "alpine:latest"], { stdio: "ignore" });
  }, 300_000);

  afterAll(() => {
    for (const name of [TINY_NAME, NOLIMIT_NAME, `${TINY_NAME}-sub`, `${NOLIMIT_NAME}-sub`]) {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    }
  });

  // Mirrors compose.yaml's docker-proxy entrypoint: patch the idle timeouts in the in-image template
  // before the stock entrypoint generates /tmp/haproxy.cfg from it. `value` is the HAProxy duration
  // to write — `0` disables (what the shipped stack does); `2s` reproduces the incident's idle cut
  // in seconds instead of ten minutes.
  function startProxy(name: string, port: number, timeout: string): Docker {
    const env = proxyEnvFromCompose();
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    execFileSync("docker", [
      "run",
      "-d",
      "--name",
      name,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "--entrypoint",
      "/bin/sh",
      "-p",
      `${String(port)}:2375`,
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock:ro",
      PROXY_IMAGE,
      "-ec",
      `sed -i 's/timeout client 10m/timeout client ${timeout}/; s/timeout server 10m/timeout server ${timeout}/' /usr/local/etc/haproxy/haproxy.cfg.template\n` +
        "exec /usr/local/bin/docker-entrypoint.sh haproxy -f /tmp/haproxy.cfg",
    ]);
    return new Docker({ host: "127.0.0.1", port });
  }

  async function waitForPing(docker: Docker): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await docker.ping();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // Races container.wait() against a wall-clock budget. "resolved:<code>" only if wait returned the
  // real exit before the budget; "rejected" if the cut surfaced as an error; "pending" if it never
  // settled (the production hang). An idle wait that was severed can never be "resolved:0".
  async function idleWaitOutcome(
    container: Docker.Container,
    budgetMs: number,
  ): Promise<string> {
    return Promise.race([
      container
        .wait()
        .then((r: { StatusCode: number }) => `resolved:${String(r.StatusCode)}`)
        .catch(() => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), budgetMs)),
    ]);
  }

  async function idleWaitThroughProxy(
    docker: Docker,
    subName: string,
    budgetMs: number,
  ): Promise<string> {
    await waitForPing(docker);
    // Sleeps with no stdout: the attach and the wait long-poll are both idle for six seconds, which
    // is what a real dump/restore does for far longer.
    const container = await docker.createContainer({
      Image: "alpine:latest",
      Cmd: ["sleep", "6"],
      name: subName,
    });
    try {
      await container.start();
      return await idleWaitOutcome(container, budgetMs);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  it("severs an idle wait at the idle timeout — the production hang, reproduced in seconds", async () => {
    const tiny = startProxy(TINY_NAME, TINY_PORT, "2s");
    // The container exits at 6s; a healthy wait resolves just after. With a 2s idle timeout the wait
    // long-poll is cut at 2s and never returns the real exit, so by 8s it has NOT resolved with 0.
    const outcome = await idleWaitThroughProxy(tiny, `${TINY_NAME}-sub`, 8000);
    expect(outcome).not.toBe("resolved:0");
  }, 300_000);

  it("returns the real exit code once the idle timeout is disabled — the fix", async () => {
    const nolimit = startProxy(NOLIMIT_NAME, NOLIMIT_PORT, "0");
    // Same idle six-second job; with the timeout disabled the wait survives past the point the cut
    // would have happened and returns exit 0.
    const outcome = await idleWaitThroughProxy(nolimit, `${NOLIMIT_NAME}-sub`, 14000);
    expect(outcome).toBe("resolved:0");
  }, 300_000);

  it("compose.yaml disables both idle timeouts, so the shipped stack cannot regress", () => {
    const composePath = fileURLToPath(new URL("../../../compose.yaml", import.meta.url));
    const compose = readFileSync(composePath, "utf8");
    const afterProxy = compose.split(/^ {2}docker-proxy:$/m)[1] ?? "";
    // Bound to the docker-proxy service: cut at the next top-level section so a stray match elsewhere
    // cannot make this pass for the wrong reason.
    const service = afterProxy.split(/^\S/m)[0] ?? afterProxy;
    expect(service).toMatch(/sed -i .*timeout client 0.*timeout server 0/);
  });
});
