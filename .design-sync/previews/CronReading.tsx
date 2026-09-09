// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { CronReading } from "@schrodump/web";

const now = new Date("2026-09-09T12:00:00");

export function Nightly() {
  return <CronReading cron="0 2 * * *" enabled now={now} className="text-sm" />;
}

export function Weekly() {
  return <CronReading cron="30 3 * * 0" enabled now={now} className="text-sm" />;
}

export function Paused() {
  return <CronReading cron="0 2 * * *" enabled={false} now={now} className="text-sm" />;
}
