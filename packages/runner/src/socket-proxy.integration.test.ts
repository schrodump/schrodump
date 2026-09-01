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
