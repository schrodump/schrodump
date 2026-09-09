// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { FieldHelp, FieldLabel, Input } from "@schrodump/web";

export function Plain() {
  return (
    <div className="max-w-sm space-y-1.5">
      <FieldLabel htmlFor="prefix">Prefix</FieldLabel>
      <Input id="prefix" defaultValue="schrodump/" />
      <FieldHelp>Every object this destination writes lands under this key prefix.</FieldHelp>
    </div>
  );
}

export function Caution() {
  return (
    <div className="max-w-sm space-y-1.5">
      <FieldLabel htmlFor="verify">Verify</FieldLabel>
      <Input id="verify" defaultValue="NONE" readOnly />
      <FieldHelp caution>Verify is off: every artifact this policy writes stays UNOBSERVED.</FieldHelp>
    </div>
  );
}
