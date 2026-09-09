// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { GroupHeader, RuledList } from "@schrodump/web";

export function ByDay() {
  return (
    <RuledList className="max-w-2xl">
      <GroupHeader label="Today" count={16} />
      <div className="border-b border-border px-[18px] py-2.5 text-sm text-muted-foreground">…16 rows</div>
      <GroupHeader label="Yesterday" count={9} />
      <div className="border-b border-border px-[18px] py-2.5 text-sm text-muted-foreground">…9 rows</div>
      <GroupHeader label="Sep 7" count={4} />
      <div className="px-[18px] py-2.5 text-sm text-muted-foreground">…4 rows</div>
    </RuledList>
  );
}
