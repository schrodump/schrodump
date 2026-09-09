// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { ErrorState } from "@schrodump/web";

export function WithRetry() {
  return (
    <div className="max-w-2xl">
      <ErrorState message="the server answered 502 from the destination probe" onRetry={() => undefined} />
    </div>
  );
}

export function WithoutRetry() {
  return (
    <div className="max-w-2xl">
      <ErrorState message="this session is not allowed to read the audit trail" />
    </div>
  );
}
