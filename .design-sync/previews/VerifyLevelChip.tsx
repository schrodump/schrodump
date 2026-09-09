// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { StatusBadge, VerifyLevelChip } from "@schrodump/web";

export function HowTheGreenWasEarned() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <VerifyLevelChip level="FULL_RESTORE" degraded={false} state="VERIFIED" />
      <VerifyLevelChip level="CHECKSUM" degraded={false} state="VERIFIED" />
    </div>
  );
}

export function Degraded() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusBadge state="VERIFIED" />
      <VerifyLevelChip level="CHECKSUM" degraded state="VERIFIED" />
    </div>
  );
}

export function NoVerdictYet() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusBadge state="UNOBSERVED" />
      <VerifyLevelChip level={null} degraded={false} state="UNOBSERVED" />
    </div>
  );
}
