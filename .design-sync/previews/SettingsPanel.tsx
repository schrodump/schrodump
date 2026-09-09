// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { DetailGrid, SettingsPanel } from "@schrodump/web";

export function WithAside() {
  return (
    <div className="max-w-2xl">
      <SettingsPanel
        title="Encryption keys"
        description="Every artifact is encrypted to the operational key and to the escrow key. Rotation retires the old key; it is kept, labelled, so older artifacts still open."
        aside="admin"
      >
        <DetailGrid
          facts={[
            { label: "Operational key", value: "age1qx…7f2c · active" },
            { label: "Escrow key", value: "age1m9…e01a · active" },
            { label: "Retired", value: "1 key, since Aug 12" },
          ]}
        />
      </SettingsPanel>
    </div>
  );
}

export function Plain() {
  return (
    <div className="max-w-2xl">
      <SettingsPanel title="This instance" description="What the server was started with.">
        <DetailGrid
          facts={[
            { label: "Version", value: "0.1.0-rc.16" },
            { label: "Scratch", value: "/var/lib/schrodump/scratch · 40 GB free" },
            { label: "Executor network", value: "schrodump_targets" },
          ]}
        />
      </SettingsPanel>
    </div>
  );
}
