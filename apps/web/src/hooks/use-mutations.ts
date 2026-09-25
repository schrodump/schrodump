// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { EngineKind } from "@/lib/domain";
import type { CreatedMember, DiscoverResult, Member, NotificationChannel } from "@/lib/types";

// Everything a mutation actually changed, invalidated together.
//
// A backup, a verify and a restore all write a job AND decide an artifact's state, but only
// `["jobs"]` was ever invalidated — and the restore invalidated nothing at all. The catalog stayed
// amber after the verify that had already turned it green, and the only way to see the truth was
// F5. The same gap sat under the two checks: a canary and a test-connection are RECORDED, on the
// destination and on the target, and the guided setup reads exactly those recorded results — so a
// green "Canary passed" could sit directly above a row still reading "never checked".
//
// Nothing here flips a state locally. The verdict is the server's; invalidating is how the screen
// asks for it again.
function invalidate(client: QueryClient, ...keys: string[]): () => void {
  return () => {
    for (const key of keys) void client.invalidateQueries({ queryKey: [key] });
  };
}

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

// The server records the probe on the target (`lastProbeOk`/`lastProbeAt`), so the very row this
// verdict renders under, and the guided setup's "prove the target is reachable" step, both go stale
// the moment it answers.
export function useTestConnection() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (targetId: string) => api.post<DiscoverResult>(`/targets/${targetId}/test-connection`),
    onSuccess: invalidate(client, "targets"),
  });
}

// Opens a connection with credentials that have not been saved and lists what the server holds, so
// the target's scope is chosen from what exists. Nothing is persisted by this call.
export function useDiscoverDatabases() {
  return useMutation({
    mutationFn: (body: {
      engine: EngineKind;
      host: string;
      port: number;
      username: string;
      password: string;
      tls: boolean;
      // Discovery runs over the connection the backup will use, CA included, so a pasted CA is
      // proved before anything is saved.
      tlsCaCert: string | null;
    }) => api.post<DiscoverResult>("/targets/discover", body),
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

// Recorded on the destination (`lastCanaryOk`/`lastCanaryAt`), and read back both by the row's
// `LastCheck` and by the guided setup's canary step.
export function useCanary() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (destinationId: string) =>
      api.post<{ ok: boolean; failedOperation: string | null }>(
        `/destinations/${destinationId}/canary`,
      ),
    onSuccess: invalidate(client, "destinations"),
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
    onSuccess: invalidate(client, "jobs", "artifacts"),
  });
}

export function useTriggerVerify() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (artifactId: string) =>
      api.post<{ jobId: string }>(`/artifacts/${artifactId}/verify`),
    onSuccess: invalidate(client, "jobs", "artifacts"),
  });
}

export function useTriggerRestore() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { artifactId: string; target: string; confirmExistingDatabase: boolean }) =>
      api.post<{ jobId: string }>(`/artifacts/${input.artifactId}/restore`, {
        target: input.target,
        confirmExistingDatabase: input.confirmExistingDatabase,
      }),
    onSuccess: invalidate(client, "jobs", "artifacts"),
  });
}

// acknowledgeVerified rides in the body only when the operator ticked it for a VERIFIED artifact;
// the server refuses a VERIFIED delete without it. Invalidates artifacts (the list AND its counts)
// so the dashboard's unobserved/verified tally corrects the moment a row is gone.
export function useDeleteArtifact() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { artifactId: string; acknowledgeVerified: boolean }) =>
      api.delete<void>(`/artifacts/${input.artifactId}`, {
        acknowledgeVerified: input.acknowledgeVerified,
      }),
    // And the jobs: every ledger row carries the verdict on the artifact it touched, so a deleted
    // one must stop being painted beside the run that wrote it.
    onSuccess: invalidate(client, "artifacts", "jobs"),
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

// Answers "does this channel actually deliver?" by delivering. The reply reports what happened —
// including that it failed — so the caller reads `ok` rather than assuming a 200 means it arrived.
export function useTestNotificationChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; channel: NotificationChannel }>(`/notification-channels/${id}/test`),
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
