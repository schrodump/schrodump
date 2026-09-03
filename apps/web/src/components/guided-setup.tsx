// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDestinations, useEncryptionKeys, usePolicies, useTargets } from "@/hooks/use-resources";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";

interface Step {
  key: MessageKey;
  href: string;
  done: boolean;
}

export function GuidedSetup() {
  const t = useT();
  const destinations = useDestinations();
  const targets = useTargets();
  const policies = usePolicies();
  const keys = useEncryptionKeys();

  // First, and not by taste. Until both keys exist every backup fails inside resolveRecipients, so
  // a checklist that started at "destination" walked the operator through four steps and then a
  // failed job with a message about a key they were never told to create.
  const hasKeys = (keys.data ?? []).some((key) => key.type === "escrow" && key.state === "active");
  const hasDestination = (destinations.data ?? []).length > 0;
  const hasTarget = (targets.data ?? []).length > 0;
  const hasVerifyingPolicy = (policies.data ?? []).some((policy) => policy.verifyLevel !== "NONE");
  // `=== true`, not truthiness: null is "never run" and false is "ran and was refused", and
  // neither is a destination proven writable or a target proven reachable. Both used to be
  // permanently unticked prompts, because the outcome was returned to one browser and kept
  // nowhere; the server records them now.
  const hasPassingCanary = (destinations.data ?? []).some((d) => d.lastCanaryOk === true);
  const hasPassingProbe = (targets.data ?? []).some((target) => target.lastProbeOk === true);

  // The two checks are part of being set up, not decoration. A bucket nobody proved writable is
  // the same open question this product refuses to paint green anywhere else, so the card stays
  // until they are answered rather than dismissing with work outstanding.
  if (hasKeys && hasDestination && hasTarget && hasVerifyingPolicy && hasPassingCanary && hasPassingProbe)
    return null;

  const steps: Step[] = [
    { key: "guided.step.keys", href: "/settings", done: hasKeys },
    { key: "guided.step.destination", href: "/destinations", done: hasDestination },
    { key: "guided.step.canary", href: "/destinations", done: hasPassingCanary },
    { key: "guided.step.target", href: "/targets", done: hasTarget },
    { key: "guided.step.probe", href: "/targets", done: hasPassingProbe },
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
            <li
              key={`${step.key}-${index}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1"
              data-done={step.done ? "true" : "false"}
            >
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
              <span className={step.done ? "text-muted-foreground line-through" : ""}>
                {t(step.key)}
              </span>
              {step.done ? (
                <span className="text-sm text-[var(--color-state-verified)]">
                  {t("guided.done")}
                </span>
              ) : (
                <>
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
