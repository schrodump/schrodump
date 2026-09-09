// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { useState } from "react";
import { AcknowledgeCheckbox } from "@schrodump/web";

function Gate({ initial }: { initial: boolean }) {
  const [checked, setChecked] = useState(initial);
  return (
    <div className="max-w-md">
      <AcknowledgeCheckbox
        checked={checked}
        onChange={setChecked}
        context="This artifact was verified by a full restore. Deleting it throws away a proven-good backup."
      >
        I understand this backup restores, and I want it gone.
      </AcknowledgeCheckbox>
    </div>
  );
}

export function Unticked() {
  return <Gate initial={false} />;
}

export function Ticked() {
  return <Gate initial />;
}
