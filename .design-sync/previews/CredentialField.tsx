// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { useState } from "react";
import { CredentialField } from "@schrodump/web";

export function New() {
  const [value, setValue] = useState("");
  return (
    <div className="max-w-sm">
      <CredentialField id="password" label="Password" configured={false} value={value} onChange={setValue} />
    </div>
  );
}

export function Configured() {
  const [value, setValue] = useState("");
  return (
    <div className="max-w-sm">
      <CredentialField id="password-stored" label="Password" configured value={value} onChange={setValue} />
    </div>
  );
}
