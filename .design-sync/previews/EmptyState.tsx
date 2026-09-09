// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { EmptyState } from "@schrodump/web";

export function NoPolicies() {
  return (
    <div className="max-w-2xl">
      <EmptyState message="No policies yet. Create one to schedule the first backup." />
    </div>
  );
}
