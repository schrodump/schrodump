// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { pollInterval, useDocumentVisible, workInFlight } from "@/hooks/use-live-refresh";
import type {
  ArtifactList,
  AuditList,
  Destination,
  EncryptionKey,
  Instance,
  JobList,
  Member,
  NotificationChannel,
  Policy,
  SelfBackupList,
  Target,
} from "@/lib/types";

// The catalog is the screen a verify is watched from, so it moves at the ledger's cadence: fast
// while a job is in flight, slow otherwise, stopped while the tab is hidden. It has no jobs of its
// own to read, which is why it subscribes to the ledger's list through `useWorkInFlight` — the
// artifact's state is the server's, and the only thing that changes it is a job finishing.
export function useArtifacts() {
  const interval = useLivePollInterval();
  return useQuery({
    queryKey: ["artifacts"],
    queryFn: () => api.get<ArtifactList>("/artifacts"),
    refetchInterval: interval,
  });
}

// The ledger decides its own cadence from what it just fetched — no second source to keep in step.
export function useJobs() {
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => api.get<JobList>("/jobs"),
    refetchInterval: (query) => pollInterval(visible, workInFlight(query.state.data)),
  });
}

// "Is anything running?" is a fact about the jobs table, and every live screen needs it. Calling
// this subscribes to `["jobs"]`, so a screen that only shows artifacts still learns when the work
// it triggered is over. One shared query key: two subscribers cost one request.
export function useWorkInFlight(): boolean {
  return workInFlight(useJobs().data);
}

// The cadence a live screen is actually running at, so the indicator states it rather than
// repeating a constant that could drift from the queries.
export function useLivePollInterval(): number | false {
  return pollInterval(useDocumentVisible(), useWorkInFlight());
}

// admin-only on the server; a non-admin's query 403s and the page renders that as an error rather
// than an empty trail (which would read as "nothing happened").
export function useAuditLog() {
  return useQuery({ queryKey: ["audit-log"], queryFn: () => api.get<AuditList>("/audit-log") });
}

export function useTargets() {
  return useQuery({ queryKey: ["targets"], queryFn: () => api.get<Target[]>("/targets") });
}

export function useDestinations() {
  return useQuery({
    queryKey: ["destinations"],
    queryFn: () => api.get<Destination[]>("/destinations"),
  });
}

export function useNotificationChannels() {
  return useQuery({
    queryKey: ["notification-channels"],
    queryFn: () => api.get<NotificationChannel[]>("/notification-channels"),
  });
}

export function usePolicies() {
  return useQuery({ queryKey: ["policies"], queryFn: () => api.get<Policy[]>("/policies") });
}

export function useMembers() {
  return useQuery({
    queryKey: ["members"],
    queryFn: () => api.get<Member[]>("/members"),
    // Admin-only, like /instance and /self-backups: a 403 is an answer, not a transient failure.
    retry: false,
  });
}

export function useInstance() {
  return useQuery({
    queryKey: ["instance"],
    queryFn: () => api.get<Instance>("/instance"),
    // Admin-only, like /self-backups: a 403 is an answer, not a transient failure.
    retry: false,
  });
}

export function useSelfBackups() {
  return useQuery({
    queryKey: ["self-backups"],
    queryFn: () => api.get<SelfBackupList>("/self-backups"),
    // Admin-only endpoint: a viewer or operator gets 403, and retrying a 403 forever just burns
    // requests to be told the same thing.
    retry: false,
  });
}

export function useEncryptionKeys() {
  return useQuery({
    queryKey: ["encryption-keys"],
    queryFn: () => api.get<EncryptionKey[]>("/encryption-keys"),
  });
}
