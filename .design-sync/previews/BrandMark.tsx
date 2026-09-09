// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { BrandMark } from "@schrodump/web";

export function Sizes() {
  return (
    <div className="flex items-end gap-6">
      <BrandMark className="size-6" />
      <BrandMark className="size-9" />
      <BrandMark className="size-16" />
    </div>
  );
}

export function WithTheName() {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark className="size-9" />
      <span className="text-base font-semibold tracking-tight">Schrodump</span>
    </div>
  );
}
