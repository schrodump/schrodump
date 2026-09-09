// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { FieldLabel, Select } from "@schrodump/web";

export function Engine() {
  return (
    <div className="max-w-sm space-y-1.5">
      <FieldLabel htmlFor="engine">Engine</FieldLabel>
      <Select id="engine" defaultValue="postgres">
        <option value="postgres">PostgreSQL</option>
        <option value="mysql">MySQL</option>
        <option value="mariadb">MariaDB</option>
        <option value="mongodb">MongoDB</option>
      </Select>
    </div>
  );
}

export function FixedOnEdit() {
  return (
    <div className="max-w-sm space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <FieldLabel htmlFor="engine-fixed">Engine</FieldLabel>
        <span className="font-mono text-[10.5px] text-subtle-foreground">fixed after creation</span>
      </div>
      <Select id="engine-fixed" defaultValue="postgres" disabled>
        <option value="postgres">PostgreSQL</option>
      </Select>
    </div>
  );
}
