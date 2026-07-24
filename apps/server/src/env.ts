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
  SCHRODUMP_MAX_CONCURRENT_STAGED: z.coerce.number().int().default(2),
  SCHRODUMP_EXECUTOR_NETWORK: z.string().default("schrodump_targets"),
  WORKER_POLL_MS: z.coerce.number().int().default(2000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
