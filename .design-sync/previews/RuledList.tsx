// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { ColumnHeaders, GroupHeader, ListFooter, RuledList, StatusBadge } from "@schrodump/web";

const GRID = "grid grid-cols-[1.4fr_1fr_0.8fr_0.8fr] items-center gap-3";

const ROWS = [
  { id: "cmtuga00", target: "IPOG Nexus", state: "UNOBSERVED", size: "1.2 GB", age: "3 hours ago" },
  { id: "cmtufy2z", target: "Billing", state: "VERIFIED", size: "412 MB", age: "yesterday" },
  { id: "cmtu9k1p", target: "Warehouse", state: "FAILED", size: "876 B", age: "2 days ago" },
] as const;

export function Ledger() {
  return (
    <RuledList className="max-w-2xl">
      <ColumnHeaders
        gridClassName={GRID}
        columns={[
          { key: "artifact", label: "Artifact" },
          { key: "state", label: "State" },
          { key: "size", label: "Size" },
          { key: "age", label: "Written" },
        ]}
      />
      <GroupHeader label="Today" count={3} />
      {ROWS.map((row) => (
        <div key={row.id} className={`${GRID} border-b border-border px-[18px] py-2.5 text-sm`}>
          <span>
            <span className="font-mono text-xs">{row.id}</span>
            <span className="ml-2 text-muted-foreground">{row.target}</span>
          </span>
          <StatusBadge state={row.state} />
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{row.size}</span>
          <span className="font-mono text-xs text-subtle-foreground">{row.age}</span>
        </div>
      ))}
      <ListFooter shown={3} total={1284} />
    </RuledList>
  );
}

export function Empty() {
  return (
    <RuledList className="max-w-2xl">
      <ColumnHeaders
        gridClassName={GRID}
        columns={[
          { key: "artifact", label: "Artifact" },
          { key: "state", label: "State" },
          { key: "size", label: "Size" },
          { key: "age", label: "Written" },
        ]}
      />
      <div className="px-[18px] py-8 text-center text-sm text-muted-foreground">
        No artifacts match these filters.
      </div>
    </RuledList>
  );
}
