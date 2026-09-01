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
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
