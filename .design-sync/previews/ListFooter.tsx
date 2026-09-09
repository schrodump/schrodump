// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { ListFooter, RuledList } from "@schrodump/web";

export function Truncated() {
  return (
    <RuledList className="max-w-2xl">
      <div className="border-b border-border px-[18px] py-2.5 text-sm text-muted-foreground">…50 rows</div>
      <ListFooter shown={50} total={1284} />
    </RuledList>
  );
}

export function EverythingShown() {
  return (
    <RuledList className="max-w-2xl">
      <div className="border-b border-border px-[18px] py-2.5 text-sm text-muted-foreground">…12 rows</div>
      <ListFooter shown={12} total={12} note="Retention keeps the last 12 of this policy." />
    </RuledList>
  );
}
