// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AuthFrame } from "@/components/auth-frame";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/form-bits";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { useT } from "@/i18n/provider";
import { signIn } from "@/lib/auth-client";

// Email, password, one button. The error says as little as it can on purpose: it must not tell a
// stranger whether an address exists here. There is no self-signup and no forgot-password link,
// because account recovery runs through the CLI on the host (docs/install.md).
export default function LoginPage() {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const result = await signIn.email({ email, password });
    setLoading(false);
    if (result.error) {
      setError(t("auth.login.error"));
      return;
    }
    router.push("/");
  }

  return (
    <AuthFrame title={t("auth.login.title")} intro={t("app.tagline")} footer={t("auth.login.footer")}>
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
        {error !== null ? (
          <Panel tone="error" role="alert" className="p-3">
            <p className="text-[12.5px] text-destructive-text">{error}</p>
          </Panel>
        ) : null}
        <div className="space-y-1.5">
          <FieldLabel htmlFor="email">{t("auth.login.email")}</FieldLabel>
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
          <FieldLabel htmlFor="password">{t("auth.login.password")}</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <Button type="submit" variant="primary" className="w-full" disabled={loading}>
          {loading ? t("common.loading") : t("auth.login.submit")}
        </Button>
      </form>
    </AuthFrame>
  );
}
