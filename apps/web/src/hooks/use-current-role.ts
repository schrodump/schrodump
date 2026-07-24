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
export function useCurrentRole(): Role {
  const { data } = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ role: Role }>("/me") });
  return data?.role ?? "viewer";
}
