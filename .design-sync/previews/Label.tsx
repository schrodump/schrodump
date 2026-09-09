// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Input, Label } from "@schrodump/web";

export function WithAnInput() {
  return (
    <div className="max-w-sm space-y-1.5">
      <Label htmlFor="email">Email</Label>
      <Input id="email" type="email" placeholder="ops@example.com" />
    </div>
  );
}
