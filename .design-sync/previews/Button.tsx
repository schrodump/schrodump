// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Button } from "@schrodump/web";

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary">Run backup now</Button>
      <Button variant="accent">Verify again</Button>
      <Button variant="secondary">Edit target</Button>
      <Button variant="quiet">Cancel</Button>
      <Button variant="ghost">Show details</Button>
      <Button variant="danger">Delete permanently</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary">Save policy</Button>
      <Button variant="primary" size="sm">
        Save policy
      </Button>
      <Button variant="quiet" size="sm">
        Verify
      </Button>
    </div>
  );
}

export function Blocked() {
  return (
    <div className="flex flex-col items-end gap-3">
      <Button variant="danger" disabledReason="tick the acknowledgement above">
        Delete permanently
      </Button>
      <Button variant="primary" disabledReason="a backup for this policy is already running">
        Run backup now
      </Button>
    </div>
  );
}
