// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Skeleton } from "@schrodump/web";

export function Lines() {
  return (
    <div className="flex max-w-md flex-col gap-2">
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-4 w-40" />
    </div>
  );
}

export function RowPlaceholder() {
  return (
    <div className="flex max-w-md items-center gap-4 rounded-panel border border-border bg-card px-[18px] py-3">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-4 w-32" />
      <Skeleton className="ml-auto h-4 w-16" />
    </div>
  );
}
