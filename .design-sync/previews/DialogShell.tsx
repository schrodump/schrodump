// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { Button, DialogShell, Panel, RetypeToConfirm, SubjectRow } from "@schrodump/web";

const noop = () => undefined;

export function DeleteArtifact() {
  return (
    <DialogShell
      titleId="delete-title"
      title="Delete this artifact?"
      description="Deletion reaches the bucket. The object and its manifest are removed; there is no undo."
      subject={<SubjectRow state="UNOBSERVED" name="IPOG Nexus" facts={["postgres · STREAM", "1.2 GB", "cmtuga00"]} />}
      footerHint="Retype the id to enable the action"
      actions={
        <>
          <Button variant="quiet" onClick={noop}>
            Cancel
          </Button>
          <Button variant="danger" disabledReason="the id does not match yet">
            Delete permanently
          </Button>
        </>
      }
      onClose={noop}
    >
      <Panel tone="danger" className="p-4">
        <p className="text-sm font-medium text-destructive-text">This reaches the bucket.</p>
        <ul className="mt-2 space-y-1 font-mono text-xs">
          <li>— the object org/ipog-nexus/2026-09-09T18-46-12.archive</li>
          <li>— its manifest</li>
          <li>— the globals dump beside it</li>
        </ul>
      </Panel>
      <RetypeToConfirm
        id="delete-confirm"
        label="Type the artifact id to confirm"
        hint="cmtuga00"
        subject="cmtuga00"
        value=""
        onChange={noop}
        mismatch="That is not this artifact's id."
      />
    </DialogShell>
  );
}
