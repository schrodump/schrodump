// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Suspense, useState, type FormEvent } from "react";
import { AuthFrame } from "@/components/auth-frame";
import { ErrorState, LoadingState } from "@/components/feedback";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldHelp, FieldLabel } from "@/components/ui/form-bits";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n/provider";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";

// The server's own floor (auth.ts minPasswordLength); asking for it here saves a round trip that
// would end in the same refusal.
const MIN_PASSWORD = 12;

// Reachable once, with a token that came in the container's logs. When an administrator already
// exists the route still answers, and says so, rather than showing a form that would be refused.
function SetupForm() {
  const t = useT();
  const params = useSearchParams();
  const fromLink = params.get("token") ?? "";
  const [token, setToken] = useState(fromLink);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const check = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => api.get<{ setupRequired: boolean }>("/setup"),
    retry: false,
  });

  const createAdmin = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/setup", { token, email, password }),
  });

  const closed = check.isError && check.error instanceof ApiError && check.error.status === 404;
  const blocked: string | null =
    token.trim().length === 0
      ? t("setup.blocked.token")
      : email.trim().length === 0
        ? t("setup.blocked.email")
        : password.length < MIN_PASSWORD
          ? t("setup.blocked.password")
          : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (blocked !== null) return;
    createAdmin.mutate();
  }

  if (check.isPending) return <LoadingState />;

  if (closed) {
    return <AuthFrame title={t("setup.closed.title")} intro={t("setup.closed.description")}>{null}</AuthFrame>;
  }

  if (createAdmin.isSuccess) {
    return (
      <AuthFrame title={t("setup.done.title")} intro={t("setup.done.description")}>
        <Link href="/login" className={cn(buttonVariants({ variant: "primary" }), "w-full")}>
          {t("setup.done.goToLogin")}
        </Link>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title={t("setup.title")} intro={t("setup.description")} width="max-w-md">
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <FieldLabel htmlFor="token">{t("setup.token")}</FieldLabel>
            {fromLink.length > 0 && token === fromLink ? (
              <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-state-verified">
                {t("setup.tokenPrefilled")}
              </span>
            ) : null}
          </div>
          <Input id="token" value={token} className="font-mono" spellCheck={false} onChange={(event) => setToken(event.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="email">{t("setup.email")}</FieldLabel>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="password">{t("setup.password")}</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <FieldHelp>{t("setup.passwordHelp")}</FieldHelp>
        </div>
        {createAdmin.isError ? <ErrorState message={createAdmin.error.message} /> : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          disabled={createAdmin.isPending}
          disabledReason={createAdmin.isPending ? null : blocked}
        >
          {createAdmin.isPending ? t("common.loading") : t("setup.submit")}
        </Button>
      </form>
    </AuthFrame>
  );
}

export default function SetupPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <SetupForm />
    </Suspense>
  );
}
