// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { StateCounters } from "@schrodump/web";

const oldest = (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] tracking-[0.13em] uppercase text-subtle-foreground">
    <span>Oldest unverified</span>
    <span className="rounded-sm border border-state-unobserved-border bg-state-unobserved-soft px-2 py-0.5 tracking-[0.04em] normal-case text-state-unobserved">
      6 days ago — IPOG Nexus / Stream
    </span>
  </div>
);

export function CatalogHeader() {
  return (
    <StateCounters
      counts={{ UNOBSERVED: 617, VERIFIED: 588, FAILED: 79 }}
      total={1284}
      verifiedByLevel={{ FULL_RESTORE: 412, CHECKSUM: 176 }}
      caption="Artifacts the backup jobs wrote, and what a restore proved about each."
      hint="Lead with the open question: the unobserved count is what to bring down."
      facts={oldest}
    />
  );
}

export function NothingFailed() {
  return (
    <StateCounters
      counts={{ UNOBSERVED: 3, VERIFIED: 42, FAILED: 0 }}
      total={45}
      verifiedByLevel={{ FULL_RESTORE: 42, CHECKSUM: 0 }}
      caption="A small deployment after its first week."
    />
  );
}
