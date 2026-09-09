// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { ColumnHeaders, RuledList } from "@schrodump/web";

const GRID = "grid grid-cols-[1.4fr_1fr_0.8fr_0.8fr] items-center gap-3";

export function FourColumns() {
  return (
    <RuledList className="max-w-2xl">
      <ColumnHeaders
        gridClassName={GRID}
        columns={[
          { key: "job", label: "Job" },
          { key: "state", label: "State" },
          { key: "took", label: "Took" },
          { key: "when", label: "Local time", className: "text-right" },
        ]}
      />
      <div className="px-[18px] py-3 text-sm text-muted-foreground">rows follow, one per job</div>
    </RuledList>
  );
}
