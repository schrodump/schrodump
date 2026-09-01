// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useEncryptionKeys } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import type { EncryptionKey, ProvisionedKeys } from "@/lib/types";

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

function KeyRow({ entry }: { entry: EncryptionKey }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b py-2 last:border-0">
      <div className="min-w-0">
        <span className="font-medium">
          {entry.type === "operational" ? t("keys.type.operational") : t("keys.type.escrow")}
        </span>
        <p className="truncate font-mono text-xs text-muted-foreground">{entry.publicRecipient}</p>
      </div>
      <span className="text-xs text-muted-foreground">
        {entry.serverCanDecrypt ? t("keys.serverHolds") : t("keys.offline")}
      </span>
    </div>
  );
}

export function EncryptionKeysPanel({ canEdit }: { canEdit: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const keys = useEncryptionKeys();
  const [mode, setMode] = useState<"generate" | "recipient">("generate");
  const [recipient, setRecipient] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const existing = keys.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("keys.title")}</CardTitle>
        <CardDescription>{t("keys.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {revealed !== null ? (
          <EscrowReveal identity={revealed} onDone={() => setRevealed(null)} />
        ) : existing.length > 0 ? (
          <div>
            {existing.map((entry) => (
              <KeyRow key={entry.keyId} entry={entry} />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-[var(--color-state-unobserved)]">{t("keys.none")}</p>
            {canEdit ? (
              <form onSubmit={submit} className="space-y-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="escrow-mode"
                    checked={mode === "generate"}
                    onChange={() => setMode("generate")}
                  />
                  <span>{t("keys.mode.generate")}</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="escrow-mode"
                    checked={mode === "recipient"}
                    onChange={() => setMode("recipient")}
                  />
                  <span>{t("keys.mode.recipient")}</span>
                </label>
                {mode === "recipient" ? (
                  <div className="space-y-1">
                    <label htmlFor="escrow-recipient" className="text-sm font-medium">
                      {t("keys.recipient.label")}
                    </label>
                    <input
                      id="escrow-recipient"
                      required
                      value={recipient}
                      onChange={(event) => setRecipient(event.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">{t("keys.recipient.hint")}</p>
                  </div>
                ) : null}
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
