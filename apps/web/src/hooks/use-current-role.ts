// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Role } from "@/lib/domain";

// The RBAC role lives on the organization membership and is resolved server-side per request; it is
// not part of the Better-Auth session. GET /me exposes it. While the query is loading, or if it
// fails, the UI fails closed to "viewer" — which hides restore. The server enforces operator+ on
// restore independently, so this is UX, not the control.
interface Me {
  role: Role;
  mustChangePassword: boolean;
}

function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });
}

export function useCurrentRole(): Role {
  const { data } = useMe();
  return data?.role ?? "viewer";
}

// True while the bootstrap password — the one from SCHRODUMP_ADMIN_PASSWORD, readable in
// `docker inspect` — has not been rotated. The server refuses every action in that state, so the
// UI's job is to explain WHY and offer the way out, not to guess. Defaults to false while loading:
// showing a rotation demand to someone who does not owe one is worse than showing it a beat late,
// and the server is the control either way.
export function useMustChangePassword(): boolean {
  const { data } = useMe();
  return data?.mustChangePassword ?? false;
}
