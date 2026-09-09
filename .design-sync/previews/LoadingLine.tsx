// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { LoadingLine, SettingsPanel } from "@schrodump/web";

export function InASettingsPanel() {
  return (
    <div className="max-w-2xl">
      <SettingsPanel title="This instance" description="What the server was started with.">
        <LoadingLine />
      </SettingsPanel>
    </div>
  );
}
