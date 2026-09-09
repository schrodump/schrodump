// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useT } from "@/i18n/provider";
import type { ArtifactState, VerifyLevel } from "@/lib/domain";
import { cn } from "@/lib/cn";

// How deep the check went — never whether it passed. The verdict lives only in the StateMarker; a
// green chip beside a red FAILED would read as "the restore passed", so no appearance here carries
// a colour of its own except the one that must: a CHECKSUM that was DOWNGRADED from a requested
// FULL_RESTORE takes the caution tint, because that green was earned on weaker evidence than the
// operator asked for and painting it like the restore-proven one beside it is exactly the blur the
// product forbids.
//
// A null level on an UNOBSERVED artifact says "no verdict yet" — an honest sentence, and true after
// an INCONCLUSIVE verify as much as before any verify. A null level on a VERIFIED or FAILED artifact
// predates the field and says nothing at all: "checksum" there would be a false claim, and "no
// verdict" a false one too.
const BASE =
  "inline-flex items-center gap-1.5 rounded-chip border px-2 py-[2px] font-mono text-[10.5px] tracking-[0.04em]";

export function VerifyLevelChip({
  level,
  degraded,
  state,
}: {
  level: VerifyLevel | null;
  degraded: boolean;
  state: ArtifactState;
}) {
  const t = useT();
  if (level === null) {
    if (state !== "UNOBSERVED") return null;
    return (
      <span
        data-testid="verify-level-none"
        className={cn(BASE, "border-dashed border-border text-subtle-foreground")}
      >
        — {t("artifacts.noVerdict")}
      </span>
    );
  }
  const caution = level === "CHECKSUM" && degraded;
  return (
    <span
      data-testid={`verify-level-${level}${degraded ? "-degraded" : ""}`}
      data-caution={caution ? "true" : undefined}
      title={caution ? t("artifacts.downgradedReason") : undefined}
      className={cn(
        BASE,
        caution
          ? "border-caution-border bg-caution-soft text-caution"
          : level === "CHECKSUM"
            ? "border-dashed border-border-region text-subtle-foreground"
            : "border-border-region text-muted-foreground",
      )}
    >
      {t(caution ? "artifacts.checksumOnly" : `verifyLevel.${level}`)}
    </span>
  );
}
