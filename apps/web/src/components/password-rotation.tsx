// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { AuthFrame } from "@/components/auth-frame";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/form-bits";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { useT } from "@/i18n/provider";

// Shown INSTEAD of the app, not above it, while the bootstrap password stands. The server refuses
// every action in that state, so rendering the dashboard behind a banner would be a screen full of
// controls that all fail — the operator would read it as the product being broken rather than as
// one thing being asked of them.
//
// Twelve characters is the server's own floor (auth.ts minPasswordLength); asking for it here
// only saves a round trip that would end in the same refusal. It is a floor, not a strength
// check — a determined operator can still choose a weak password.
const MIN_LENGTH = 12;

export function PasswordRotation() {
  const t = useT();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next.length < MIN_LENGTH) return setError(t("rotate.tooShort"));
    if (next !== confirm) return setError(t("rotate.mismatch"));
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        // revokeOtherSessions: the bootstrap password may have been used elsewhere while it was
        // sitting in `docker inspect`. Rotating it without cutting those sessions would leave
        // whoever read it still signed in.
        body: JSON.stringify({ currentPassword: current, newPassword: next, revokeOtherSessions: true }),
      });
      if (!response.ok) {
        setError(t("rotate.failed"));
        return;
      }
      // The flag lives on the server; refetch rather than assume. If the server did not clear it,
      // the operator stays here — which is the honest outcome.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title={t("rotate.title")}
      width="max-w-md"
      intro={
        <Panel tone="warning" className="p-3">
          <p className="text-[12.5px] text-pretty">{t("rotate.why")}</p>
        </Panel>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="current">{t("rotate.current")}</FieldLabel>
          <Input id="current" type="password" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="next">{t("rotate.new")}</FieldLabel>
          <Input id="next" type="password" autoComplete="new-password" required value={next} onChange={(event) => setNext(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="confirm">{t("rotate.confirm")}</FieldLabel>
          <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </div>
        {error !== null ? (
          <Panel tone="error" role="alert" className="p-3">
            <p className="text-[12.5px] text-destructive-text">{error}</p>
          </Panel>
        ) : null}
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? t("common.loading") : t("rotate.submit")}
        </Button>
        <p className="text-[12px] text-muted-foreground text-pretty">{t("rotate.revokes")}</p>
      </form>
    </AuthFrame>
  );
}
