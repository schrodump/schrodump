// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { AcknowledgeCheckbox } from "@/components/ui/acknowledge-checkbox";
import { Button } from "@/components/ui/button";
import { FieldHelp, FieldLabel, SectionLabel } from "@/components/ui/form-bits";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { AdminOnly, SettingsPanel } from "@/components/settings-panel";
import { useEncryptionKeys } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
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
      <SectionLabel>{t("keys.escrowIdentity")}</SectionLabel>
      <pre className="overflow-x-auto rounded-control border border-border-region bg-background p-3 font-mono text-[12px] break-all whitespace-pre-wrap">
        <code>{identity}</code>
      </pre>
      <Panel tone="warning" className="p-3">
        <p className="text-[12.5px] text-pretty">{t("keys.escrowWarning")}</p>
      </Panel>
      <AcknowledgeCheckbox checked={acknowledged} onChange={setAcknowledged}>
        {t("keys.escrowSaved")}
      </AcknowledgeCheckbox>
      <div className="flex justify-end">
        <Button variant="primary" onClick={onDone} disabledReason={acknowledged ? null : t("keys.revealDone.blocked")}>
          {t("common.done")}
        </Button>
      </div>
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
  const option = (value: EscrowMode, label: string) => (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-control border px-3 py-2 text-sm",
        mode === value ? "border-accent-border bg-accent-soft" : "border-border hover:border-border-region",
      )}
    >
      <input type="radio" name={`${idPrefix}-escrow-mode`} checked={mode === value} onChange={() => setMode(value)} />
      <span>{label}</span>
    </label>
  );
  return (
    <div className="space-y-2">
      {option("generate", t("keys.mode.generate"))}
      {option("recipient", t("keys.mode.recipient"))}
      {mode === "recipient" ? (
        <div className="space-y-1.5 pt-1">
          <FieldLabel htmlFor={`${idPrefix}-escrow-recipient`}>{t("keys.recipient.label")}</FieldLabel>
          <Input
            id={`${idPrefix}-escrow-recipient`}
            required
            value={recipient}
            spellCheck={false}
            placeholder="age1…"
            className="font-mono"
            onChange={(event) => setRecipient(event.target.value)}
          />
          <FieldHelp>{t("keys.recipient.hint")}</FieldHelp>
        </div>
      ) : null}
    </div>
  );
}

function KeyRow({ entry, canEdit, onRotate }: { entry: EncryptionKey; canEdit: boolean; onRotate: (type: EncryptionKey["type"]) => void }) {
  const t = useT();
  const retired = entry.state === "retired";
  return (
    <div className={cn("border-b border-border py-2.5 last:border-0", retired && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13.5px] font-medium">{entry.type === "operational" ? t("keys.type.operational") : t("keys.type.escrow")}</span>
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.13em] uppercase",
            retired ? "border-border text-subtle-foreground" : "border-state-verified-border bg-state-verified-soft text-state-verified",
          )}
        >
          {retired ? t("keys.state.retired") : t("keys.state.active")}
        </span>
        <span className="font-mono text-[11px] text-subtle-foreground">
          {entry.serverCanDecrypt ? t("keys.serverHolds") : t("keys.offline")}
        </span>
        {canEdit && !retired ? (
          <Button variant="quiet" size="sm" className="ml-auto" onClick={() => onRotate(entry.type)}>
            {t("keys.rotate")}
          </Button>
        ) : null}
      </div>
      <p className="mt-1 truncate font-mono text-[11.5px] text-muted-foreground">{entry.publicRecipient}</p>
      {/* A retired key is not dead weight, and saying so here stops an operator from reading the
          extra row as clutter to be cleaned up. It is what opens everything written before it
          was rotated. */}
      {retired ? <p className="mt-1 text-[12px] text-muted-foreground">{t("keys.retiredHint")}</p> : null}
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
    if (!acknowledged) return;
    if (type === "operational") return onConfirm(null);
    onConfirm(mode === "generate" ? { mode: "generate" } : { mode: "recipient", publicRecipient: recipient.trim() });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <h3 className="text-[15px] font-semibold">{t("keys.rotate.confirmTitle")}</h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground text-pretty">{t("keys.rotate.whatItDoes")}</p>
      </div>
      <Panel tone="danger" className="p-3">
        <div className="font-mono text-[10px] tracking-[0.13em] uppercase text-destructive-text">{t("keys.rotate.exposureTitle")}</div>
        <p className="mt-1 text-[12.5px] text-pretty">{t("keys.rotate.notRemediation")}</p>
      </Panel>
      {/* Only escrow leaves the operator holding something. For operational the outgoing identity
          stays on the server, so promising them a chore they do not have would be noise. */}
      {type === "escrow" ? (
        <Panel tone="warning" className="p-3">
          <div className="font-mono text-[10px] tracking-[0.13em] uppercase text-caution">{t("keys.rotate.retainTitle")}</div>
          <p className="mt-1 text-[12.5px] text-pretty">{t("keys.rotate.escrowRetain")}</p>
        </Panel>
      ) : null}
      {type === "escrow" ? (
        <div className="space-y-2">
          <SectionLabel>{t("keys.rotate.replacement")}</SectionLabel>
          <EscrowModeFields mode={mode} setMode={setMode} recipient={recipient} setRecipient={setRecipient} idPrefix="rotate" />
        </div>
      ) : null}
      <AcknowledgeCheckbox checked={acknowledged} onChange={setAcknowledged}>
        {t("keys.rotate.acknowledge")}
      </AcknowledgeCheckbox>
      {error !== null ? (
        <p role="alert" className="text-[12.5px] text-destructive-text">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="quiet" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="danger" disabled={busy} disabledReason={busy || acknowledged ? null : t("keys.rotate.blocked")}>
          {t("keys.rotate.confirm")}
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
          escrow: mode === "generate" ? { mode: "generate" } : { mode: "recipient", publicRecipient: recipient.trim() },
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

  const rotate = async (escrow: { mode: "generate" } | { mode: "recipient"; publicRecipient: string } | null) => {
    if (rotating === null) return;
    setRotateError(null);
    setBusy(true);
    try {
      const response = await fetch("/backend/encryption-keys/rotate", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rotating === "operational" ? { type: "operational" } : { type: "escrow", escrow }),
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
  const existing = [...(keys.data ?? [])].sort((a, b) => (a.state === b.state ? 0 : a.state === "active" ? -1 : 1));

  return (
    <SettingsPanel title={t("keys.title")} description={t("keys.description")} aside={canEdit ? t("keys.aside") : undefined}>
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
            <Panel tone="warning" className="p-3">
              <p className="text-[12.5px] text-pretty">{notice}</p>
              <p className="mt-1 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">{t("keys.fromServer")}</p>
            </Panel>
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
          <Panel tone="warning" className="p-3">
            <p className="text-[12.5px]">{t("keys.none")}</p>
          </Panel>
          {canEdit ? (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1">
                <SectionLabel>{t("keys.operationalKey")}</SectionLabel>
                <FieldHelp>{t("keys.operationalExplain")}</FieldHelp>
              </div>
              <div className="space-y-2">
                <SectionLabel>{t("keys.escrowKey")}</SectionLabel>
                <EscrowModeFields mode={mode} setMode={setMode} recipient={recipient} setRecipient={setRecipient} idPrefix="provision" />
              </div>
              {error !== null ? (
                <p role="alert" className="text-[12.5px] text-destructive-text">
                  {error}
                </p>
              ) : null}
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? t("common.loading") : t("keys.generate")}
              </Button>
            </form>
          ) : (
            <AdminOnly>{t("keys.aside")}</AdminOnly>
          )}
        </div>
      )}
    </SettingsPanel>
  );
}
