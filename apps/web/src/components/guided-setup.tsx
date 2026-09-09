// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { useDestinations, useEncryptionKeys, usePolicies, useTargets } from "@/hooks/use-resources";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";

interface Step {
  key: MessageKey;
  dest: MessageKey;
  href: string;
  done: boolean;
  // Why an undone step is undone when the server recorded an attempt: a canary that ran and was
  // refused is not "not yet run", and the row says which.
  note?: MessageKey;
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
  const canaryRefused = !hasPassingCanary && (destinations.data ?? []).some((d) => d.lastCanaryOk === false);
  const probeRefused = !hasPassingProbe && (targets.data ?? []).some((target) => target.lastProbeOk === false);

  // The two checks are part of being set up, not decoration. A bucket nobody proved writable is
  // the same open question this product refuses to paint green anywhere else, so the card stays
  // until they are answered rather than dismissing with work outstanding.
  if (hasKeys && hasDestination && hasTarget && hasVerifyingPolicy && hasPassingCanary && hasPassingProbe) return null;

  const steps: Step[] = [
    { key: "guided.step.keys", dest: "guided.dest.settings", href: "/settings", done: hasKeys },
    { key: "guided.step.destination", dest: "guided.dest.destinations", href: "/destinations", done: hasDestination },
    {
      key: "guided.step.canary",
      dest: "guided.dest.destinations",
      href: "/destinations",
      done: hasPassingCanary,
      ...(canaryRefused ? { note: "guided.canaryRefused" as const } : {}),
    },
    { key: "guided.step.target", dest: "guided.dest.targets", href: "/targets", done: hasTarget },
    {
      key: "guided.step.probe",
      dest: "guided.dest.targets",
      href: "/targets",
      done: hasPassingProbe,
      ...(probeRefused ? { note: "guided.probeRefused" as const } : {}),
    },
    { key: "guided.step.policy", dest: "guided.dest.policies", href: "/policies", done: hasVerifyingPolicy },
  ];
  const doneCount = steps.filter((step) => step.done).length;

  return (
    <Panel tone="section" className="mb-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold">{t("guided.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">{t("guided.description")}</p>
        </div>
        <div className="min-w-40">
          <div className="font-mono text-[10.5px] tracking-[0.13em] uppercase text-subtle-foreground">
            {t("guided.progress", { done: String(doneCount), total: String(steps.length) })}
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-sm bg-muted" aria-hidden="true">
            <div className="h-full bg-state-verified" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
        </div>
      </div>

      <ol className="mt-4 divide-y divide-border border-y border-border">
        {steps.map((step, index) => (
          <li
            key={`${step.key}-${index}`}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto_auto] items-start gap-x-3 gap-y-1 py-2.5"
            data-done={step.done ? "true" : "false"}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-6 items-center justify-center rounded-full border font-mono text-[11px]",
                step.done
                  ? "border-state-verified-border bg-state-verified-soft text-state-verified"
                  : "border-border-region text-subtle-foreground",
              )}
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <div className={cn("text-[13.5px]", step.done ? "text-subtle-foreground line-through" : "")}>{t(step.key)}</div>
              {step.note !== undefined ? <div className="mt-0.5 text-[12px] text-caution">{t(step.note)}</div> : null}
            </div>
            <span className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-subtle-foreground">{t(step.dest)}</span>
            {step.done ? (
              <span className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-state-verified">{t("guided.done")}</span>
            ) : (
              <Link href={step.href} className={cn(buttonVariants({ variant: "quiet", size: "sm" }))}>
                {t("guided.open")}
              </Link>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[12px] text-muted-foreground text-pretty">{t("guided.footer")}</p>
    </Panel>
  );
}
