// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { AccountMenu } from "@schrodump/web";

const noop = () => undefined;

export function Closed() {
  return (
    <div className="flex max-w-xs justify-end">
      <AccountMenu email="ana.ribeiro@ipog.edu.br" onSignOut={noop} />
    </div>
  );
}

export function ShortAddress() {
  return (
    <div className="flex max-w-xs justify-end">
      <AccountMenu email="ops@example.com" onSignOut={noop} />
    </div>
  );
}
