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
  // SCHRODUMP_TZ: the zone the scheduler reads every cron in. On /me because every role needs it
  // and the policy form needs it before any policy exists.
  timeZone: string;
  // Whether this deployment has scratch — what STAGED dumps and full-restore verifies need. It was
  // readable only from the admin-only GET /instance, so an operator's policy form always read
  // "no scratch". Optional so an older server simply leaves the question unanswered.
  scratchConfigured?: boolean;
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

// The instance's zone, or null until the server has said. Deliberately no default: guessing UTC
// or the browser's zone is the exact mistake this replaces, so a caller renders no clock time
// until it knows whose clock it is.
export function useInstanceTimeZone(): string | null {
  const { data } = useMe();
  return data?.timeZone ?? null;
}

// null while /me loads or when the server does not say, so a caller can fall back rather than read
// "unknown" as "no".
export function useScratchConfigured(): boolean | null {
  const { data } = useMe();
  return data?.scratchConfigured ?? null;
}
