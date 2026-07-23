// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDestinations, usePolicies, useTargets } from "@/hooks/use-resources";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";

interface Step {
  key: MessageKey;
  href: string;
  done: boolean;
  // The server records no state for canary/probe runs, so those steps are prompts, not checkmarks.
  manual?: boolean;
}

export function GuidedSetup() {
  const t = useT();
  const destinations = useDestinations();
  const targets = useTargets();
  const policies = usePolicies();

  const hasDestination = (destinations.data ?? []).length > 0;
  const hasTarget = (targets.data ?? []).length > 0;
  const hasVerifyingPolicy = (policies.data ?? []).some((policy) => policy.verifyLevel !== "NONE");

  if (hasDestination && hasTarget && hasVerifyingPolicy) return null;

  const steps: Step[] = [
    { key: "guided.step.destination", href: "/destinations", done: hasDestination },
    { key: "guided.step.canary", href: "/destinations", done: false, manual: true },
    { key: "guided.step.target", href: "/targets", done: hasTarget },
    { key: "guided.step.probe", href: "/targets", done: false, manual: true },
    { key: "guided.step.policy", href: "/policies", done: hasVerifyingPolicy },
  ];

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t("guided.title")}</CardTitle>
        <CardDescription>{t("guided.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {steps.map((step, index) => (
            <li key={`${step.key}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                  step.done
                    ? "bg-[var(--color-state-verified-bg)] text-[var(--color-state-verified)]"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {index + 1}
              </span>
              <span className={step.done ? "text-muted-foreground line-through" : ""}>{t(step.key)}</span>
              {step.done ? (
                <span className="text-sm text-[var(--color-state-verified)]">{t("guided.done")}</span>
              ) : (
                <>
                  {step.manual ? (
                    <span className="text-xs text-muted-foreground">{t("guided.manual")}</span>
                  ) : null}
                  <Link
                    href={step.href}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-auto")}
                  >
                    {t("guided.open")}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
