// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Zod's `.partial()` infers `k?: T | undefined`; under `exactOptionalPropertyTypes` Prisma's update
// inputs want `k?: T`. Dropping the explicitly-undefined keys makes the two agree, and it is also
// the honest shape for a PATCH: a key that is not there is a field the caller did not ask to
// change, which is exactly what Prisma reads an absent key as.
//
// Only `undefined` is absence. `false`, `0` and `null` are values someone asked for — treating any
// of them as "unset" would silently swallow `enabled: false`, the one edit with no other spelling.
export function definedOnly<T extends object>(
  input: T,
): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<{ [K in keyof T]: Exclude<T[K], undefined> }>;
}
