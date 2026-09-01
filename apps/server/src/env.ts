// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Key-encryption key, base64 (decodes to 32 bytes). Losing it loses every encrypted backup.
  SCHRODUMP_KEK: z.string().min(1),
  SCHRODUMP_URL: z.string().default("http://localhost:8080"),
  SCHRODUMP_ADMIN_EMAIL: z.email().optional(),
  SCHRODUMP_ADMIN_PASSWORD: z.string().min(1).optional(),
  BETTER_AUTH_SECRET: z.string().min(1).optional(),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Worker / executor configuration. Absent scratch path -> STREAM-only (no staged/parallel).
  SCHRODUMP_SCRATCH_PATH: z.string().min(1).optional(),
  SCHRODUMP_SCRATCH_MAX_BYTES: z.coerce.number().int().default(107374182400), // 100 GiB
  SCHRODUMP_MAX_CONCURRENT_STAGED: z.coerce.number().int().min(1).default(2),
  // Dumps estimated above this are executed STAGED. Deliberately has NO default: STAGED artifacts
  // cannot be restored or FULL_RESTORE-verified in v1, so the mode is never chosen for an operator
  // by size — only by an explicit parallelism > 1 on the policy. Set it to opt in.
  SCHRODUMP_STAGED_THRESHOLD_BYTES: z.coerce.number().int().positive().optional(),
  // Minimum age of the previous notification snapshot before it is allowed to anchor the
  // "verification is falling behind" comparison. Below this, the previous point is ignored: every
  // healthy backup is briefly UNOBSERVED between finishing and its chained verify, so comparing two
  // evaluations seconds apart would alert on success. Default 15 minutes.
  SCHRODUMP_NOTIFY_MIN_GAP_MS: z.coerce.number().int().positive().default(900000),
  SCHRODUMP_EXECUTOR_NETWORK: z.string().default("schrodump_targets"),
  WORKER_POLL_MS: z.coerce.number().int().default(2000),
  // How often the scheduler evaluates enabled policies and dispatches due backup jobs.
  SCHRODUMP_SCHEDULER_TICK_MS: z.coerce.number().int().default(30000),
  // Bounds the awaited drain on SIGTERM. Kept under docker's default 10s stop grace so the abort +
  // scratch cleanup finish before SIGKILL. The abort itself is sub-second; this only caps a wedged
  // Docker teardown from holding the process past the window.
  SCHRODUMP_SHUTDOWN_GRACE_MS: z.coerce.number().int().default(8000),
  // Self-backup: dumps THIS deployment's metadata database to a destination the operator names.
  // Deliberately has NO default. The metadata database holds every target's wrapped credential, so
  // where it lands is a placement decision an operator makes on purpose, not one inferred from
  // whichever destination happens to be first. Unset -> no self-backup, and the server says so at
  // boot rather than staying quiet about it.
  SCHRODUMP_SELF_BACKUP_DESTINATION_ID: z.string().min(1).optional(),
  SCHRODUMP_SELF_BACKUP_INTERVAL_MS: z.coerce.number().int().positive().default(86400000), // 24h
  // The self-backup executor joins THIS network, not SCHRODUMP_EXECUTOR_NETWORK. In compose.yaml
  // the metadata database sits on `internal` only, and deliberately so — putting it on the target
  // network would expose it to every executor that talks to a customer database. So the one dump
  // that must reach it joins `internal` instead, for the length of that dump and nothing else.
  SCHRODUMP_SELF_BACKUP_NETWORK: z.string().default("schrodump_internal"),
  // Comma-separated CIDRs for every hop in front of this server (your TLS-terminating reverse
  // proxy, plus 127.0.0.1/32 for the UI's internal rewrite in the shipped image). Decides whether
  // the login rate limit buckets on the real client address or on something an attacker controls.
  // See auth.ts. Unset -> nothing trusted, and the server warns at boot.
  SCHRODUMP_TRUSTED_PROXIES: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
