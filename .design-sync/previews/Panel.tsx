// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Panel } from "@schrodump/web";

export function Section() {
  return (
    <Panel className="max-w-md p-5">
      <h3 className="text-sm font-semibold">Retention</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Keep the last 7 daily, 4 weekly and 6 monthly artifacts. Retention deletes from the bucket;
        an artifact under a legal hold is never counted.
      </p>
    </Panel>
  );
}

export function InfoAndLock() {
  return (
    <div className="flex max-w-md flex-col gap-3">
      <Panel tone="info" className="p-4 text-sm">
        The setup link is valid for 30 minutes and can be used once.
      </Panel>
      <Panel tone="lock" className="p-4 text-sm">
        A replica set is dumped whole, with its oplog. This target cannot be narrowed to one
        database.
      </Panel>
    </div>
  );
}

export function Warning() {
  return (
    <Panel tone="warning" role="alert" className="max-w-md p-4 text-sm">
      Verify is off for this policy. Every artifact it writes stays UNOBSERVED until something
      opens it and checks.
    </Panel>
  );
}

export function DangerAndError() {
  return (
    <div className="flex max-w-md flex-col gap-3">
      <Panel tone="danger" className="p-4">
        <p className="text-sm font-medium text-destructive-text">This reaches the bucket.</p>
        <ul className="mt-2 space-y-1 font-mono text-xs">
          <li>— the object org/shop/2026-09-09.archive</li>
          <li>— its manifest</li>
        </ul>
        <p className="mt-2 text-sm">There is no undo.</p>
      </Panel>
      <Panel tone="error" className="p-4 text-sm">
        The server refused: INSUFFICIENT_PRIVILEGES. Grant the user read on the databases this
        target should back up.
      </Panel>
    </div>
  );
}

export function Empty() {
  return (
    <Panel tone="empty" className="max-w-md p-6 text-center text-sm text-muted-foreground">
      No artifacts yet. The first backup of this policy runs tonight at 02:00.
    </Panel>
  );
}
