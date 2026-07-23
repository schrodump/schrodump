// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { HealthResult } from "./driver.js";

// The three operations a canary exercises against one throwaway key, in order.
export interface CanaryOps {
  put(key: string): Promise<void>;
  get(key: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// Runs PUT -> GET -> DELETE against a throwaway object under the real configured prefix and
// reports which step failed.
//
// Why DELETE is part of the check: validating only the credential (or only PUT + GET) lets a
// key with `s3:PutObject` but WITHOUT `s3:DeleteObject` pass. Backups then succeed for months
// while retention silently fails to reclaim space. A health check that never tests deletion is
// useless for this application.
//
// The returned message is a fixed label, never the underlying error, so no provider detail
// (endpoint, request id, credentials) can leak through the health report.
export async function runCanary(key: string, ops: CanaryOps): Promise<HealthResult> {
  try {
    await ops.put(key);
  } catch {
    return { ok: false, failedOperation: "put", message: "PUT failed" };
  }
  try {
    await ops.get(key);
  } catch {
    return { ok: false, failedOperation: "get", message: "GET failed" };
  }
  try {
    await ops.delete(key);
  } catch {
    return { ok: false, failedOperation: "delete", message: "DELETE failed" };
  }
  return { ok: true, failedOperation: null, message: null };
}
