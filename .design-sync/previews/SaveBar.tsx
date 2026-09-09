// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { SaveBar } from "@schrodump/web";

const noop = () => undefined;

export function Ready() {
  return (
    <div className="max-w-xl">
      <SaveBar note="Saved targets are probed before every run." blocked={null} pending={false} primary="Save target" onCancel={noop} />
    </div>
  );
}

export function Blocked() {
  return (
    <div className="max-w-xl">
      <SaveBar note="Saved targets are probed before every run." blocked="name the database to back up" pending={false} primary="Save target" onCancel={noop} />
    </div>
  );
}

export function Pending() {
  return (
    <div className="max-w-xl">
      <SaveBar note="Saved targets are probed before every run." blocked={null} pending primary="Save target" onCancel={noop} />
    </div>
  );
}
