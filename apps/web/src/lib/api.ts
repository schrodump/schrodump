// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Typed client for the server API, reached through the same-origin /backend proxy so the
// Better-Auth session cookie travels automatically.

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function extractError(data: unknown): string | null {
  if (typeof data === "object" && data !== null && "error" in data) {
    const value = (data as Record<string, unknown>).error;
    if (typeof value === "string") return value;
  }
  return null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/backend${path}`, {
    method,
    credentials: "include",
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      message = extractError(await response.json()) ?? message;
    } catch {
      // response had no JSON body
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>("GET", path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>("PATCH", path, body),
  delete: <T>(path: string): Promise<T> => request<T>("DELETE", path),
};
