// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ProbeFailureCode } from "@/lib/domain";

export function useCreateTarget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api.post<{ id: string }>("/targets", body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["targets"] }),
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (targetId: string) =>
      api.post<{ ok: boolean; serverVersionNum: number | null; failure: ProbeFailureCode | null; driverCode: string | null }>(
        `/targets/${targetId}/test-connection`,
      ),
  });
}

export function useCreateDestination() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api.post<{ id: string }>("/destinations", body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["destinations"] }),
  });
}

export function useCanary() {
  return useMutation({
    mutationFn: (destinationId: string) =>
      api.post<{ ok: boolean; failedOperation: string | null }>(`/destinations/${destinationId}/canary`),
  });
}

export function useCreatePolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api.post<{ id: string }>("/policies", body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["policies"] }),
  });
}

export function useTriggerBackup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (policyId: string) => api.post<{ jobId: string }>(`/policies/${policyId}/backup`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useTriggerVerify() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (artifactId: string) => api.post<{ jobId: string }>(`/artifacts/${artifactId}/verify`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

// The server currently returns 501 for restore execution; the payload shape below is what the
// endpoint will accept once wiring lands.
export function useTriggerRestore() {
  return useMutation({
    mutationFn: (input: { artifactId: string; target: string; confirmExistingDatabase: boolean }) =>
      api.post(`/artifacts/${input.artifactId}/restore`, {
        target: input.target,
        confirmExistingDatabase: input.confirmExistingDatabase,
      }),
  });
}
