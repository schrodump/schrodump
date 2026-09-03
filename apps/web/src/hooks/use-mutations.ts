// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ProbeFailureCode } from "@/lib/domain";
import type { CreatedMember, Member, NotificationChannel } from "@/lib/types";

export function useCreateTarget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api.post<{ id: string }>("/targets", body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["targets"] }),
  });
}

// PATCH bodies carry only the fields being changed. Omitting the secret is meaningful, not a
// missing value: it tells the server to keep the stored credential, which is the only way to edit
// a host or a region when the UI can never read the secret back to re-submit it.
export function useUpdateTarget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: unknown }) =>
      api.patch<{ id: string }>(`/targets/${input.id}`, input.body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["targets"] }),
  });
}

export function useDeleteTarget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (targetId: string) => api.delete<void>(`/targets/${targetId}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["targets"] }),
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (targetId: string) =>
      api.post<{
        ok: boolean;
        serverVersionNum: number | null;
        failure: ProbeFailureCode | null;
        driverCode: string | null;
      }>(`/targets/${targetId}/test-connection`),
  });
}

export function useCreateDestination() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api.post<{ id: string }>("/destinations", body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["destinations"] }),
  });
}

export function useUpdateDestination() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: unknown }) =>
      api.patch<{ id: string }>(`/destinations/${input.id}`, input.body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["destinations"] }),
  });
}

export function useDeleteDestination() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (destinationId: string) => api.delete<void>(`/destinations/${destinationId}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["destinations"] }),
  });
}

export function useCanary() {
  return useMutation({
    mutationFn: (destinationId: string) =>
      api.post<{ ok: boolean; failedOperation: string | null }>(
        `/destinations/${destinationId}/canary`,
      ),
  });
}

export function useCreatePolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api.post<{ id: string }>("/policies", body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["policies"] }),
  });
}

export function useUpdatePolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: unknown }) =>
      api.patch<{ id: string }>(`/policies/${input.id}`, input.body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["policies"] }),
  });
}

export function useDeletePolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (policyId: string) => api.delete<void>(`/policies/${policyId}`),
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
    mutationFn: (artifactId: string) =>
      api.post<{ jobId: string }>(`/artifacts/${artifactId}/verify`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useTriggerRestore() {
  return useMutation({
    mutationFn: (input: { artifactId: string; target: string; confirmExistingDatabase: boolean }) =>
      api.post<{ jobId: string }>(`/artifacts/${input.artifactId}/restore`, {
        target: input.target,
        confirmExistingDatabase: input.confirmExistingDatabase,
      }),
  });
}

export function useCreateNotificationChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<NotificationChannel>("/notification-channels", body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["notification-channels"] }),
  });
}

// Disabling, not deleting, is the reversible operation and the one the interface leads with:
// deleting a channel that is recording delivery failures throws away the only evidence it was
// failing.
export function useSetNotificationChannelEnabled() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.post<NotificationChannel>(`/notification-channels/${id}/enabled`, { enabled }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["notification-channels"] }),
  });
}

export function useDeleteNotificationChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/notification-channels/${id}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["notification-channels"] }),
  });
}

// The response carries the temporary password, and it is the ONLY time it exists in readable form.
// The caller has to hold it in component state and show it — there is no second GET that returns
// it, by design, exactly as with the escrow identity.
export function useCreateMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; name: string; role: string }) =>
      api.post<CreatedMember>("/members", body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["members"] }),
  });
}

export function useUpdateMemberRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; role: string }) =>
      api.patch<Member>(`/members/${input.userId}`, { role: input.role }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["members"] }),
  });
}

export function useDeleteMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/members/${userId}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["members"] }),
  });
}
