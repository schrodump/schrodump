// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/i18n/provider";

// Shown INSTEAD of the app, not above it, while the bootstrap password stands. The server refuses
// every action in that state, so rendering the dashboard behind a banner would be a screen full of
// controls that all fail — the operator would read it as the product being broken rather than as
// one thing being asked of them.
//
// A minimum of 12 characters is asked for here and nowhere else in the flow, which is a real
// limitation and not a claim: this is UI validation, the server's own floor is Better-Auth's
// default of 8, and a determined operator can still choose a weak password.
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
        body: JSON.stringify({
          currentPassword: current,
          newPassword: next,
          revokeOtherSessions: true,
        }),
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
    <div className="mx-auto max-w-lg px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>{t("rotate.title")}</CardTitle>
          <CardDescription>{t("rotate.why")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="current" className="text-sm font-medium">
                {t("rotate.current")}
              </label>
              <input
                id="current"
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="next" className="text-sm font-medium">
                {t("rotate.new")}
              </label>
              <input
                id="next"
                type="password"
                autoComplete="new-password"
                required
                value={next}
                onChange={(event) => setNext(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="confirm" className="text-sm font-medium">
                {t("rotate.confirm")}
              </label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            {error !== null ? (
              <p role="alert" className="text-sm text-[var(--color-state-failed)]">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={busy}>
              {t("rotate.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
