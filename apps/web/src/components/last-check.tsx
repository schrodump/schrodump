// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";

// The recorded outcome of an operator-triggered check — a target probe or a destination canary.
//
// Three states, and they are three: `null` is NEVER RUN, `false` is ran and was refused, `true` is
// ran and passed. The server keeps them apart deliberately; collapsing "never" into "no" here
// would tell an operator their bucket failed a check nobody has performed.
//
// "Never" is amber rather than grey for the same reason UNOBSERVED is: it is an open question, not
// an absence. A grey dash would read as "not applicable" and stop the eye.
export function LastCheck({
  ok,
  at,
  keys,
}: {
  ok: boolean | null;
  at: string | null;
  keys: { never: MessageKey; lastOk: MessageKey; lastFailed: MessageKey };
}) {
  const t = useT();
  const when = at === null ? "" : at.slice(11, 16);

  if (ok === null || at === null) {
    return (
      <span
        data-check="never"
        className="font-mono text-xs text-[var(--color-state-unobserved)]"
      >
        {t(keys.never)}
      </span>
    );
  }
  return (
    <span
      data-check={ok ? "passed" : "failed"}
      className={
        ok
          ? "font-mono text-xs text-[var(--color-state-verified)]"
          : "font-mono text-xs text-[var(--color-state-failed)]"
      }
    >
      {t(ok ? keys.lastOk : keys.lastFailed, { when })}
    </span>
  );
}
