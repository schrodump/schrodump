// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { LoadingState } from "@/components/feedback";
import { PasswordRotation } from "@/components/password-rotation";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { useCurrentRole, useMustChangePassword } from "@/hooks/use-current-role";
import type { MessageKey } from "@/i18n/messages/en";
import { LOCALES, useI18n, type Locale } from "@/i18n/provider";
import { signOut, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/cn";

// adminOnly hides the link for non-admins — the page and the API refuse them anyway, so showing a
// link that leads to a 403 would only invite a dead end. The audit trail is admin-only.
const NAV: { href: string; key: MessageKey; adminOnly?: boolean }[] = [
  { href: "/", key: "nav.dashboard" },
  { href: "/artifacts", key: "nav.artifacts" },
  { href: "/jobs", key: "nav.jobs" },
  { href: "/targets", key: "nav.targets" },
  { href: "/destinations", key: "nav.destinations" },
  { href: "/policies", key: "nav.policies" },
  { href: "/notifications", key: "nav.notifications" },
  { href: "/audit", key: "nav.audit", adminOnly: true },
  { href: "/settings", key: "nav.settings" },
];

// The locale is a short code in the bar — the language names live in the options.
const CODE: Record<Locale, string> = { en: "EN", "pt-BR": "PT-BR", es: "ES" };

function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">{t("locale.label")}</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        className="h-8 appearance-none rounded-control border border-border bg-background pr-6 pl-2.5 font-mono text-[10.5px] tracking-[0.08em] uppercase text-muted-foreground outline-none transition-colors hover:border-border-region hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-accent-soft"
      >
        {LOCALES.map((code) => (
          <option key={code} value={code}>
            {CODE[code]} · {t(`locale.${code}`)}
          </option>
        ))}
      </select>
      <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.4" className="pointer-events-none absolute right-2 text-subtle-foreground">
        <path d="M1 3l3 3 3-3" />
      </svg>
    </label>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = useSession();
  const mustRotate = useMustChangePassword();
  const role = useCurrentRole();
  const nav = NAV.filter((item) => item.adminOnly !== true || role === "admin");

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
  // Before the chrome, not inside it: every navigation target behind this would 403.
  if (mustRotate) return <PasswordRotation />;

  // The bar: the mark and the name, the nav as segments, then the controls. Sticky and a single
  // rule under it — 58px, so it never competes with the page's own header.
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex min-h-[58px] max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2">
          <Link href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
            <BrandMark className="size-7" />
            {t("app.name")}
          </Link>
          <nav className="flex flex-1 flex-wrap items-center gap-0.5" aria-label={t("nav.dashboard")}>
            {nav.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-control px-2.5 py-1.5 text-[13px] transition-colors",
                    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {t(item.key)}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-2">
            <LocaleSwitch />
            <ThemeToggle />
            <span className="hidden font-mono text-[11px] text-subtle-foreground md:inline">{session.user.email}</span>
            <Button variant="quiet" size="sm" onClick={() => void signOut()}>
              {t("nav.signOut")}
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
