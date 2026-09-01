// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ArtifactList, Destination, JobList, NotificationChannel, Policy, SelfBackupList, Target } from "@/lib/types";

export function useArtifacts() {
  return useQuery({ queryKey: ["artifacts"], queryFn: () => api.get<ArtifactList>("/artifacts") });
}

export function useJobs() {
  return useQuery({ queryKey: ["jobs"], queryFn: () => api.get<JobList>("/jobs") });
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

export function useSelfBackups() {
  return useQuery({
    queryKey: ["self-backups"],
    queryFn: () => api.get<SelfBackupList>("/self-backups"),
    // Admin-only endpoint: a viewer or operator gets 403, and retrying a 403 forever just burns
    // requests to be told the same thing.
    retry: false,
  });
}
