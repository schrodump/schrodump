// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useEncryptionKeys } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import type { EncryptionKey, ProvisionedKeys, RotatedKey } from "@/lib/types";

type EscrowMode = "generate" | "recipient";

// The escrow identity is shown exactly once, in the response to its own creation. It is not stored
// anywhere — not on the server, not in this component's query cache — so the only copy that will
// ever exist is the one the operator takes from this screen.
//
// Hence the acknowledgement checkbox. It is not consent theatre: dismissing this panel is
// irreversible, and an operator who closes the tab has an escrow key protecting nothing. The one
// backup that needs it is the one taken after the metadata database is already gone.
function EscrowReveal({ identity, onDone }: { identity: string; onDone: () => void }) {
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t("keys.escrowIdentity")}</p>
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs">
        <code>{identity}</code>
      </pre>
      <p className="text-sm text-[var(--color-state-unobserved)]">{t("keys.escrowWarning")}</p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-1"
        />
        <span>{t("keys.escrowSaved")}</span>
      </label>
      <Button disabled={!acknowledged} onClick={onDone}>
        {t("common.done")}
      </Button>
    </div>
  );
}

// The escrow mode choice, shared by provisioning and rotation. Rotation offers it for the same
// reason provisioning does: an operator who keeps age keys offline must not be pushed onto a
// server-generated key just because they are replacing one.
function EscrowModeFields({
  mode,
  setMode,
  recipient,
  setRecipient,
  idPrefix,
}: {
  mode: EscrowMode;
  setMode: (mode: EscrowMode) => void;
  recipient: string;
  setRecipient: (value: string) => void;
  idPrefix: string;
}) {
  const t = useT();
  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name={`${idPrefix}-escrow-mode`}
          checked={mode === "generate"}
          onChange={() => setMode("generate")}
        />
        <span>{t("keys.mode.generate")}</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name={`${idPrefix}-escrow-mode`}
          checked={mode === "recipient"}
          onChange={() => setMode("recipient")}
        />
        <span>{t("keys.mode.recipient")}</span>
      </label>
      {mode === "recipient" ? (
        <div className="space-y-1">
          <label htmlFor={`${idPrefix}-escrow-recipient`} className="text-sm font-medium">
            {t("keys.recipient.label")}
          </label>
          <input
            id={`${idPrefix}-escrow-recipient`}
            required
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">{t("keys.recipient.hint")}</p>
        </div>
      ) : null}
    </>
  );
}

function KeyRow({
  entry,
  canEdit,
  onRotate,
}: {
  entry: EncryptionKey;
  canEdit: boolean;
  onRotate: (type: EncryptionKey["type"]) => void;
}) {
  const t = useT();
  const retired = entry.state === "retired";
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b py-2 last:border-0">
      <div className="min-w-0">
        <span className={`font-medium ${retired ? "text-muted-foreground" : ""}`}>
          {entry.type === "operational" ? t("keys.type.operational") : t("keys.type.escrow")}
        </span>{" "}
        <span className="text-xs text-muted-foreground">
          {retired ? t("keys.state.retired") : t("keys.state.active")}
        </span>
        <p className="truncate font-mono text-xs text-muted-foreground">{entry.publicRecipient}</p>
        {/* A retired key is not dead weight, and saying so here stops an operator from reading the
            extra row as clutter to be cleaned up. It is what opens everything written before it
            was rotated. */}
        {retired ? <p className="text-xs text-muted-foreground">{t("keys.retiredHint")}</p> : null}
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-xs text-muted-foreground">
          {entry.serverCanDecrypt ? t("keys.serverHolds") : t("keys.offline")}
        </span>
        {canEdit && !retired ? (
          <Button variant="outline" size="sm" onClick={() => onRotate(entry.type)}>
            {t("keys.rotate")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// Friction on purpose. Rotation is cheap to perform and easy to misread: the dangerous belief is
// that rotating a leaked key closes the leak. It does not — every artifact already written stays
// sealed to the outgoing key. The acknowledgement is there so that sentence has to be read before
// the request goes.
function RotateConfirm({
  type,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  type: EncryptionKey["type"];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (escrow: { mode: "generate" } | { mode: "recipient"; publicRecipient: string } | null) => void;
}) {
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(false);
  const [mode, setMode] = useState<EscrowMode>("generate");
  const [recipient, setRecipient] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (type === "operational") return onConfirm(null);
    onConfirm(
      mode === "generate"
        ? { mode: "generate" }
        : { mode: "recipient", publicRecipient: recipient.trim() },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm font-medium">{t("keys.rotate.confirmTitle")}</p>
      <p className="text-sm text-muted-foreground">{t("keys.rotate.whatItDoes")}</p>
      <p className="text-sm text-[var(--color-state-unobserved)]">
        {t("keys.rotate.notRemediation")}
      </p>
      {/* Only escrow leaves the operator holding something. For operational the outgoing identity
          stays on the server, so promising them a chore they do not have would be noise. */}
      {type === "escrow" ? (
        <p className="text-sm text-[var(--color-state-unobserved)]">
          {t("keys.rotate.escrowRetain")}
        </p>
      ) : null}
      {type === "escrow" ? (
        <EscrowModeFields
          mode={mode}
          setMode={setMode}
          recipient={recipient}
          setRecipient={setRecipient}
          idPrefix="rotate"
        />
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-1"
        />
        <span>{t("keys.rotate.acknowledge")}</span>
      </label>
      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--color-state-failed)]">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={!acknowledged || busy}>
          {t("keys.rotate.confirm")}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

export function EncryptionKeysPanel({ canEdit }: { canEdit: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const keys = useEncryptionKeys();
  const [mode, setMode] = useState<EscrowMode>("generate");
  const [recipient, setRecipient] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState<EncryptionKey["type"] | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/backend/encryption-keys", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          escrow:
            mode === "generate"
              ? { mode: "generate" }
              : { mode: "recipient", publicRecipient: recipient.trim() },
        }),
      });
      if (!response.ok) {
        setError(t("keys.failed"));
        return;
      }
      const body = (await response.json()) as ProvisionedKeys;
      await queryClient.invalidateQueries({ queryKey: ["encryption-keys"] });
      // Held in component state only, and only until acknowledged. Never written to the query
      // cache, which survives navigation and would keep a private key alive in memory long after
      // this screen is gone.
      if (body.escrowIdentity !== null) setRevealed(body.escrowIdentity);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (
    escrow: { mode: "generate" } | { mode: "recipient"; publicRecipient: string } | null,
  ) => {
    if (rotating === null) return;
    setRotateError(null);
    setBusy(true);
    try {
      const response = await fetch("/backend/encryption-keys/rotate", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          rotating === "operational" ? { type: "operational" } : { type: "escrow", escrow },
        ),
      });
      if (!response.ok) {
        setRotateError(t("keys.rotate.failed"));
        return;
      }
      const body = (await response.json()) as RotatedKey;
      await queryClient.invalidateQueries({ queryKey: ["encryption-keys"] });
      setRotating(null);
      // The server's own sentence, not a local paraphrase: what the operator must keep is a
      // property of the rotation, and it must not drift from what the API decided.
      setNotice(body.consequences.operatorMustRetain ?? t("keys.rotate.done"));
      // Same rule as provisioning: component state only, cleared on acknowledgement.
      if (body.escrowIdentity !== null) setRevealed(body.escrowIdentity);
    } finally {
      setBusy(false);
    }
  };

  // Active first. After a rotation the list holds both, and the one that answers "can this
  // deployment take a backup right now" should not be below the one that cannot.
  const existing = [...(keys.data ?? [])].sort((a, b) =>
    a.state === b.state ? 0 : a.state === "active" ? -1 : 1,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("keys.title")}</CardTitle>
        <CardDescription>{t("keys.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {revealed !== null ? (
          <EscrowReveal identity={revealed} onDone={() => setRevealed(null)} />
        ) : rotating !== null ? (
          <RotateConfirm
            type={rotating}
            busy={busy}
            error={rotateError}
            onCancel={() => {
              setRotating(null);
              setRotateError(null);
            }}
            onConfirm={rotate}
          />
        ) : existing.length > 0 ? (
          <div className="space-y-3">
            {notice !== null ? (
              <p className="text-sm text-[var(--color-state-unobserved)]">{notice}</p>
            ) : null}
            <div>
              {existing.map((entry) => (
                <KeyRow
                  key={entry.keyId}
                  entry={entry}
                  canEdit={canEdit}
                  onRotate={(type) => {
                    setNotice(null);
                    setRotating(type);
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-[var(--color-state-unobserved)]">{t("keys.none")}</p>
            {canEdit ? (
              <form onSubmit={submit} className="space-y-3">
                <EscrowModeFields
                  mode={mode}
                  setMode={setMode}
                  recipient={recipient}
                  setRecipient={setRecipient}
                  idPrefix="provision"
                />
                {error !== null ? (
                  <p role="alert" className="text-sm text-[var(--color-state-failed)]">
                    {error}
                  </p>
                ) : null}
                <Button type="submit" disabled={busy}>
                  {t("keys.generate")}
                </Button>
              </form>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
