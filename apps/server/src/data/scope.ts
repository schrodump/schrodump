// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { PrismaClient } from "@prisma/client";

// Domain models that carry organizationId. Auth models (User/Session/Account/Verification) and
// instance-global models (SetupToken/AppConfig/Organization) are NOT scoped.
const ORG_SCOPED_MODELS = new Set([
  "Membership",
  "DatabaseTarget",
  "StorageDestination",
  "BackupPolicy",
  "BackupJob",
  "Artifact",
  "EncryptionKey",
  "AuditLog",
]);

const WHERE_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// Injects organizationId into every query on an org-scoped model — into `where` for reads,
// updates and deletes, and into `data` for creates. Forgetting the tenant filter is impossible,
// not merely discouraged. Pure and side-effect free so it can be unit tested without a database.
export function injectOrgScope(
  model: string,
  operation: string,
  args: Record<string, unknown>,
  organizationId: string,
): Record<string, unknown> {
  if (!ORG_SCOPED_MODELS.has(model)) return args;

  const next: Record<string, unknown> = { ...args };

  if (WHERE_OPERATIONS.has(operation)) {
    next.where = { ...asRecord(next.where), organizationId };
  }

  if (operation === "create") {
    next.data = { ...asRecord(next.data), organizationId };
  }

  if (operation === "createMany") {
    const data = next.data;
    next.data = Array.isArray(data)
      ? data.map((row) => ({ ...asRecord(row), organizationId }))
      : { ...asRecord(data), organizationId };
  }

  if (operation === "upsert") {
    next.where = { ...asRecord(next.where), organizationId };
    next.create = { ...asRecord(next.create), organizationId };
  }

  return next;
}

// An organization-scoped Prisma client. Route handlers receive this, never the raw client, so
// every query they issue is automatically tenant-scoped.
export function scopedPrisma(base: PrismaClient, organizationId: string) {
  return base.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          const scoped = injectOrgScope(
            model,
            operation,
            asRecord(args),
            organizationId,
          ) as typeof args;
          return query(scoped);
        },
      },
    },
  });
}

export type ScopedPrisma = ReturnType<typeof scopedPrisma>;
