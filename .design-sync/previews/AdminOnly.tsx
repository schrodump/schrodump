// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { AdminOnly } from "@schrodump/web";

export function Reason() {
  return (
    <div className="max-w-md">
      <AdminOnly>Only an admin can rotate the operational key.</AdminOnly>
    </div>
  );
}
