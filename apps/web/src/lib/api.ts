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

// The server answers a refused request with its own summary plus, when a schema rejected a field,
// which field and the schema's own sentence about it (see the server's routes/errors.ts). All three
// are joined here rather than in each caller: a form that only rendered `error` would show "invalid
// channel" and send the operator back to guessing which of five inputs was wrong.
function stringAt(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" ? value : null;
}

function extractError(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const summary = stringAt(record, "error");
  const detail = stringAt(record, "detail");
  if (detail === null) return summary;
  const field = stringAt(record, "field");
  const because = field === null ? detail : `${field}: ${detail}`;
  return summary === null ? because : `${summary} — ${because}`;
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
  delete: <T>(path: string, body?: unknown): Promise<T> => request<T>("DELETE", path, body),
};
