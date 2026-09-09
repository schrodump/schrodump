// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { LastCheck } from "@schrodump/web";

const keys = { never: "targets.probe.never", lastOk: "targets.probe.lastOk", lastFailed: "targets.probe.lastFailed" } as const;

export function Never() {
  return <LastCheck ok={null as unknown as boolean} at={null as unknown as string} keys={keys} />;
}

export function Reachable() {
  return <LastCheck ok at="2026-09-09T18:46:12.000Z" keys={keys} />;
}

export function Refused() {
  return <LastCheck ok={false} at="2026-09-09T18:46:12.000Z" keys={keys} />;
}
