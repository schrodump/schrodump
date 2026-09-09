// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { FormHeader } from "@schrodump/web";

export function Create() {
  return (
    <div className="max-w-xl">
      <FormHeader
        mode="New target"
        title="Point Schrodump at a database"
        intro="The scope is picked from what the server is found to hold — it is never typed, and there is no “all by default”."
      />
    </div>
  );
}

export function Edit() {
  return (
    <div className="max-w-xl">
      <FormHeader mode="Editing" aside="engine fixed after creation" title="IPOG Nexus" intro="Changes apply to the next run." />
    </div>
  );
}
