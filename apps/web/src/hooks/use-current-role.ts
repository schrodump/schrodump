// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useSession } from "@/lib/auth-client";
import type { Role } from "@/lib/domain";

// The RBAC role lives on the organization membership and is resolved server-side per request; it
// is not part of the better-auth session and no endpoint exposes it. Until one does, the UI cannot
// know the caller's role and fails closed to "viewer", which hides restore. The server enforces
// operator+ on restore independently, so hiding is UX, not the control.
export function useCurrentRole(): Role {
  const { data } = useSession();
  const role = (data?.user as { role?: Role } | undefined)?.role;
  return role ?? "viewer";
}
