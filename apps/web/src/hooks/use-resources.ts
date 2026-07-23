// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Artifact, Destination, Job, Policy, Target } from "@/lib/types";

export function useArtifacts() {
  return useQuery({ queryKey: ["artifacts"], queryFn: () => api.get<Artifact[]>("/artifacts") });
}

export function useJobs() {
  return useQuery({ queryKey: ["jobs"], queryFn: () => api.get<Job[]>("/jobs") });
}

export function useTargets() {
  return useQuery({ queryKey: ["targets"], queryFn: () => api.get<Target[]>("/targets") });
}

export function useDestinations() {
  return useQuery({ queryKey: ["destinations"], queryFn: () => api.get<Destination[]>("/destinations") });
}

export function usePolicies() {
  return useQuery({ queryKey: ["policies"], queryFn: () => api.get<Policy[]>("/policies") });
}
