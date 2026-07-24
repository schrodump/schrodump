// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { LOCALES, useI18n, type Locale } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages/en";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/feedback";
import { cn } from "@/lib/cn";

const NAV: { href: string; key: MessageKey }[] = [
  { href: "/", key: "nav.dashboard" },
  { href: "/targets", key: "nav.targets" },
  { href: "/destinations", key: "nav.destinations" },
  { href: "/policies", key: "nav.policies" },
  { href: "/jobs", key: "nav.jobs" },
  { href: "/artifacts", key: "nav.artifacts" },
  { href: "/settings", key: "nav.settings" },
];

function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{t("locale.label")}</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
      >
        {LOCALES.map((code) => (
          <option key={code} value={code}>
            {t(`locale.${code}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = useSession();

  useEffect(() => {
    if (!isPending && session === null) router.replace("/login");
  }, [isPending, session, router]);

  if (isPending) {
    return (
      <div className="p-8">
        <LoadingState />
      </div>
    );
  }
  if (session === null) return null;

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <Link href="/" className="font-semibold">
            {t("app.name")}
          </Link>
          <nav className="flex flex-1 flex-wrap gap-1" aria-label={t("nav.dashboard")}>
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname === item.href ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent",
                  pathname === item.href ? "bg-accent font-medium" : "text-muted-foreground",
                )}
              >
                {t(item.key)}
              </Link>
            ))}
          </nav>
          <LocaleSwitch />
          <span className="text-sm text-muted-foreground">{session.user.email}</span>
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            {t("nav.signOut")}
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
