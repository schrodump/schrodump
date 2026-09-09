// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { StateMarker } from "@schrodump/web";

export function InProse() {
  return (
    <p className="max-w-md text-sm leading-7">
      Only <StateMarker state="VERIFIED" /> means something opened the file and checked.{" "}
      <StateMarker state="UNOBSERVED" /> is the default — written, nobody looked. And{" "}
      <StateMarker state="FAILED" /> was checked and is no good.
    </p>
  );
}
