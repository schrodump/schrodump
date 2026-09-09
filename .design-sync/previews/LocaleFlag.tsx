// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { LocaleFlag } from "@schrodump/web";

export function ThreeLocales() {
  return (
    <div className="flex items-center gap-5 font-mono text-xs">
      <span className="flex items-center gap-2">
        <LocaleFlag locale="en" className="h-3.5 w-5 rounded-[2px]" /> EN
      </span>
      <span className="flex items-center gap-2">
        <LocaleFlag locale="pt-BR" className="h-3.5 w-5 rounded-[2px]" /> PT-BR
      </span>
      <span className="flex items-center gap-2">
        <LocaleFlag locale="es" className="h-3.5 w-5 rounded-[2px]" /> ES
      </span>
    </div>
  );
}
