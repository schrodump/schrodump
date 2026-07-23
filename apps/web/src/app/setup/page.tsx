// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Suspense, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { useT } from "@/i18n/provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState, LoadingState } from "@/components/feedback";
import { cn } from "@/lib/cn";

function SetupForm() {
  const t = useT();
  const params = useSearchParams();
  const [token, setToken] = useState(params.get("token") ?? "");
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

  const closed =
    check.isError && check.error instanceof ApiError && check.error.status === 404;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    createAdmin.mutate();
  }

  if (check.isPending) return <LoadingState />;

  if (closed) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("setup.closed.title")}</CardTitle>
          <CardDescription>{t("setup.closed.description")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (createAdmin.isSuccess) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("setup.done.title")}</CardTitle>
          <CardDescription>{t("setup.done.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login" className={cn(buttonVariants())}>
            {t("setup.done.goToLogin")}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("setup.title")}</CardTitle>
        <CardDescription>{t("setup.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="token">{t("setup.token")}</Label>
            <Input id="token" value={token} onChange={(event) => setToken(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">{t("setup.email")}</Label>
            <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">{t("setup.password")}</Label>
            <Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </div>
          {createAdmin.isError ? (
            <ErrorState message={createAdmin.error.message} />
          ) : null}
          <Button type="submit" className="w-full" disabled={createAdmin.isPending}>
            {createAdmin.isPending ? t("common.loading") : t("setup.submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function SetupPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Suspense fallback={<LoadingState />}>
        <SetupForm />
      </Suspense>
    </div>
  );
}
