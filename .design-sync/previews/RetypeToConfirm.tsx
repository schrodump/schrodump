// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { useState } from "react";
import { RetypeToConfirm } from "@schrodump/web";

function Gate({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="max-w-sm">
      <RetypeToConfirm
        id={`confirm-${initial || "empty"}`}
        label="Type the artifact id to confirm"
        hint="cmtuga00"
        subject="cmtuga00"
        value={value}
        onChange={setValue}
        mismatch="That is not this artifact's id."
      />
    </div>
  );
}

export function Untouched() {
  return <Gate initial="" />;
}

export function Mismatch() {
  return <Gate initial="cmtuga0x" />;
}

export function Match() {
  return <Gate initial="cmtuga00" />;
}
