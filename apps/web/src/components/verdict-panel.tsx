// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { Panel } from "@/components/ui/panel";
import { useT } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages/en";
import type { ProbeFailureCode } from "@/lib/domain";
import { formatServerVersion } from "@/lib/format";
import type { DiscoverResult } from "@/lib/types";

// What a probe came back with, said in words an operator can act on. A success names the server
// and how it was reached; a failure has a title, the sentence the catalog also shows on the row,
// and one line on what to check — parameterised by host, port and user, never by anything
// secret. The raw driver code appears only when the classification gave up: elsewhere it is
// noise, on an UNKNOWN it is the difference between a reportable failure and a dead end.
const TITLE: Record<ProbeFailureCode, MessageKey> = {
  UNREACHABLE: "targets.verdict.title.UNREACHABLE",
  TIMEOUT: "targets.verdict.title.TIMEOUT",
  AUTH_FAILED: "targets.verdict.title.AUTH_FAILED",
  INSUFFICIENT_PRIVILEGES: "targets.verdict.title.INSUFFICIENT_PRIVILEGES",
  TLS_FAILED: "targets.verdict.title.TLS_FAILED",
  UNKNOWN: "targets.verdict.title.UNKNOWN",
};
const REASON: Record<ProbeFailureCode, MessageKey> = {
  UNREACHABLE: "targets.probe.reason.UNREACHABLE",
  TIMEOUT: "targets.probe.reason.TIMEOUT",
  AUTH_FAILED: "targets.probe.reason.AUTH_FAILED",
  INSUFFICIENT_PRIVILEGES: "targets.probe.reason.INSUFFICIENT_PRIVILEGES",
  TLS_FAILED: "targets.probe.reason.TLS_FAILED",
  UNKNOWN: "targets.probe.reason.UNKNOWN",
};
const DETAIL: Record<Exclude<ProbeFailureCode, "TLS_FAILED">, MessageKey> = {
  UNREACHABLE: "targets.verdict.detail.UNREACHABLE",
  TIMEOUT: "targets.verdict.detail.TIMEOUT",
  AUTH_FAILED: "targets.verdict.detail.AUTH_FAILED",
  INSUFFICIENT_PRIVILEGES: "targets.verdict.detail.INSUFFICIENT_PRIVILEGES",
  UNKNOWN: "targets.verdict.detail.UNKNOWN",
};

export function failureCodeOf(result: DiscoverResult): ProbeFailureCode {
  return result.failure ?? "UNKNOWN";
}

export function VerdictPanel({
  result,
  hostPort,
  user,
  tls,
}: {
  result: DiscoverResult;
  hostPort: string;
  user: string;
  tls: boolean;
}) {
  const t = useT();
  if (result.ok) {
    return (
      <Panel tone="section" data-verdict="ok" className="border-state-verified-border bg-state-verified-soft p-3.5">
        <div className="text-[13px] font-medium text-state-verified">{t("targets.verdict.connected")}</div>
        <div className="mt-1 font-mono text-[12px] text-muted-foreground">
          {t("targets.verdict.line", {
            version: result.serverVersionNum !== null ? formatServerVersion(result.serverVersionNum) : "?",
            hostPort,
            tls: tls ? t("targets.verdict.tlsOn") : t("targets.verdict.tlsOff"),
          })}
        </div>
      </Panel>
    );
  }
  const code = failureCodeOf(result);
  const vars = { hostPort, user: user.length > 0 ? user : "?" };
  const detail =
    code === "TLS_FAILED"
      ? t(tls ? "targets.verdict.detail.TLS_FAILED.on" : "targets.verdict.detail.TLS_FAILED.off", vars)
      : t(DETAIL[code], vars);
  return (
    <Panel tone="error" data-verdict={code} className="p-3.5">
      <div className="text-[13px] font-medium text-destructive-text">{t(TITLE[code])}</div>
      <p className="mt-1 text-[12.5px]">{t(REASON[code])}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{detail}</p>
      {code === "UNKNOWN" && result.driverCode !== null ? (
        <p className="mt-2 font-mono text-[11px] text-subtle-foreground">
          {t("targets.verdict.code", { code: result.driverCode })}
        </p>
      ) : null}
    </Panel>
  );
}
