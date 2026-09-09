// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { SectionLabel } from "@schrodump/web";

export function Plain() {
  return (
    <div className="max-w-xl">
      <SectionLabel>Connection</SectionLabel>
    </div>
  );
}

export function WithAside() {
  return (
    <div className="max-w-xl">
      <SectionLabel aside="checked in the browser, never sent">From a URL</SectionLabel>
    </div>
  );
}
