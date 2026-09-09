// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { FilterChip } from "@schrodump/web";

const noop = () => undefined;

export function ByState() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterChip label="All" count={1284} active onClick={noop} />
      <FilterChip label="Unobserved" count={617} state="UNOBSERVED" onClick={noop} />
      <FilterChip label="Verified" count={588} state="VERIFIED" onClick={noop} />
      <FilterChip label="Failed" count={79} state="FAILED" onClick={noop} />
    </div>
  );
}

export function StateActive() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterChip label="All" count={1284} onClick={noop} />
      <FilterChip label="Unobserved" count={617} state="UNOBSERVED" active onClick={noop} />
      <FilterChip label="Verified" count={588} state="VERIFIED" onClick={noop} />
      <FilterChip label="Failed" count={79} state="FAILED" onClick={noop} />
    </div>
  );
}
