// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { FieldLabel, Input } from "@schrodump/web";

export function TextAndNumber() {
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <div className="space-y-1.5">
        <FieldLabel htmlFor="name">Name</FieldLabel>
        <Input id="name" placeholder="prod-orders" />
      </div>
      <div className="space-y-1.5">
        <FieldLabel htmlFor="host">Host</FieldLabel>
        <Input id="host" defaultValue="db.internal.example" spellCheck={false} />
      </div>
      <div className="space-y-1.5">
        <FieldLabel htmlFor="port">Port</FieldLabel>
        <Input id="port" type="number" defaultValue="5432" className="max-w-[120px]" />
      </div>
    </div>
  );
}

export function Secret() {
  return (
    <div className="max-w-sm space-y-1.5">
      <FieldLabel htmlFor="url">Connection URL</FieldLabel>
      <Input id="url" type="password" autoComplete="off" defaultValue="postgresql://app:secret@db/orders" />
    </div>
  );
}

export function Disabled() {
  return (
    <div className="max-w-sm space-y-1.5">
      <FieldLabel htmlFor="engine">Engine</FieldLabel>
      <Input id="engine" defaultValue="postgres" disabled />
    </div>
  );
}
