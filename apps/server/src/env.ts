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
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
