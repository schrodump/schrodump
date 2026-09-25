// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// What "this deployment's own control plane" resolves to, read off the configuration the
// deployment already has rather than off a list somebody has to keep in step with compose.yaml.
//
// Three variables already name every piece of it: `DATABASE_URL` is the metadata database,
// `DOCKER_HOST` is the socket proxy (root on the host, one hop away), and `SCHRODUMP_URL` is this
// API. The shipped compose service names are added on top because they are Docker network aliases,
// the same in every deployment of this file, and an operator who renames the project does not
// rename them. Adding a name costs nothing and removing the wrong one is the expensive mistake.

import { networkInterfaces } from "node:os";
import type { Env } from "../env.js";
import { COMPOSE_SERVICE_NAMES, createEgressGuard, type EgressGuard, type EgressPolicy } from "./guard.js";

// `new URL` parses any scheme, so one function covers postgres://, tcp:// and https://. A
// DATABASE_URL whose password happens to break the parse is not a reason to fail the boot here —
// Prisma will say so far more precisely — so an unreadable value contributes no name.
function hostOf(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  try {
    const host = new URL(raw).hostname;
    return host === "" ? null : host.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return null;
  }
}

// Every address this process is itself bound to, loopback included. Denying them is what makes
// "the API's own port" true however it is addressed: `127.0.0.1:8080` is already covered by the
// loopback range, and this covers the container's bridge address, which is not.
function ownAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address);
}

export interface EgressWiringInput {
  readonly deny: readonly string[];
  readonly allow: readonly string[];
  readonly databaseUrl: string;
  readonly publicUrl: string;
  // Not in env.ts: the runner (dockerode) reads DOCKER_HOST straight from the environment, so it is
  // passed in rather than validated there. Absent on a deployment that mounts the socket directly.
  readonly dockerHost: string | undefined;
  readonly selfAddresses: readonly string[];
}

export function egressPolicyFrom(input: EgressWiringInput): EgressPolicy {
  const derived = [hostOf(input.databaseUrl), hostOf(input.publicUrl), hostOf(input.dockerHost)];
  return {
    deny: input.deny,
    allow: input.allow,
    selfHosts: [...COMPOSE_SERVICE_NAMES, ...derived.filter((host): host is string => host !== null)],
    selfAddresses: input.selfAddresses,
  };
}

export function createEgressGuardFromEnv(
  env: Env,
  dockerHost: string | undefined = process.env.DOCKER_HOST,
): EgressGuard {
  return createEgressGuard(
    egressPolicyFrom({
      deny: env.SCHRODUMP_EGRESS_DENY,
      allow: env.SCHRODUMP_EGRESS_ALLOW,
      databaseUrl: env.DATABASE_URL,
      publicUrl: env.SCHRODUMP_URL,
      dockerHost,
      selfAddresses: ownAddresses(),
    }),
  );
}
