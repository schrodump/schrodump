// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { StatusBadge } from "@schrodump/web";

export function ThreeStates() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusBadge state="UNOBSERVED" />
      <StatusBadge state="VERIFIED" />
      <StatusBadge state="FAILED" />
    </div>
  );
}

export function InARow() {
  return (
    <div className="flex max-w-lg items-center gap-4 rounded-panel border border-border bg-card px-[18px] py-3 text-sm shadow-card">
      <StatusBadge state="UNOBSERVED" />
      <span className="font-mono text-xs">postgres · STREAM</span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">1.2 GB</span>
      <span className="ml-auto font-mono text-xs text-subtle-foreground">3 hours ago</span>
    </div>
  );
}
