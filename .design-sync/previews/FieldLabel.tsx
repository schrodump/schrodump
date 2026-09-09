// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { FieldLabel, Input } from "@schrodump/web";

export function OverAnInput() {
  return (
    <div className="max-w-sm space-y-1.5">
      <FieldLabel htmlFor="host">Host</FieldLabel>
      <Input id="host" defaultValue="db.ipog.internal" />
    </div>
  );
}
