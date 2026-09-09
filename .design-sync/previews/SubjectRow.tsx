// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { SubjectRow } from "@schrodump/web";

export function ThreeSubjects() {
  return (
    <div className="flex max-w-lg flex-col gap-3">
      <SubjectRow state="VERIFIED" name="IPOG Nexus" facts={["postgres · STREAM", "1.2 GB", "cmtuga00"]} />
      <SubjectRow state="UNOBSERVED" name="Billing" facts={["mysql · STAGED", "412 MB", "cmtufy2z"]} />
      <SubjectRow state="FAILED" name="Warehouse" facts={["mongodb · STREAM", "876 B", "cmtu9k1p"]} />
    </div>
  );
}
