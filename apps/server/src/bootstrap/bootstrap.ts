// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { Env } from "../env.js";
import { generateSetupToken, setupTokenExpiry } from "./setup-token.js";

// Dependencies are injected so the idempotent logic is unit tested without a database or auth.
export interface BootstrapDeps {
  userCount(): Promise<number>;
  // Creates the admin user + default org + admin membership, flagged for mandatory password change.
  createAdmin(input: { email: string; password: string }): Promise<void>;
  createSetupToken(input: { tokenHash: string; expiresAt: Date }): Promise<void>;
  now(): Date;
  setupUrl(token: string): string;
  log: { info(obj: Record<string, unknown>, msg: string): void };
}

export type BootstrapResult =
  | { kind: "already-initialized" }
  | { kind: "admin-created"; email: string }
  | { kind: "setup-token-issued" };

// Idempotent: runs on every start.
export async function bootstrap(deps: BootstrapDeps, env: Env): Promise<BootstrapResult> {
  // 1. If any user exists, do nothing.
  if ((await deps.userCount()) > 0) {
    return { kind: "already-initialized" };
  }

  // 2. If admin credentials are in env, create the admin + default org. The password is visible
  //    in `docker inspect` and in the versioned compose, so the user is flagged for a mandatory
  //    password change on first login.
  if (env.SCHRODUMP_ADMIN_EMAIL !== undefined && env.SCHRODUMP_ADMIN_PASSWORD !== undefined) {
    await deps.createAdmin({
      email: env.SCHRODUMP_ADMIN_EMAIL,
      password: env.SCHRODUMP_ADMIN_PASSWORD,
    });
    return { kind: "admin-created", email: env.SCHRODUMP_ADMIN_EMAIL };
  }

  // 3. Otherwise issue a single-use setup token (only the hash is persisted, 60-min expiry) and
  //    log the full URL.
  //
  //    Why a token: without it there is a window between the container starting and someone
  //    reaching the UI in which anyone who reaches the port claims the first admin. With a
  //    public tunnel in front, that is trivial hijacking.
  const { token, tokenHash } = generateSetupToken();
  await deps.createSetupToken({ tokenHash, expiresAt: setupTokenExpiry(deps.now()) });
  deps.log.info(
    { setupUrl: deps.setupUrl(token) },
    "setup token issued — open the URL to create the first admin",
  );
  return { kind: "setup-token-issued" };
}
