// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { nextRun, readCron } from "@/lib/cron";
import { dayGroupOf, formatDateTime, formatTime } from "@/lib/format";

// The two things a cron expression does not say on its own: what it means in words, when the
// shape has an honest sentence, and when it fires next on the viewer's clock. A disabled policy
// has no next run and says so; an expression that does not parse says that instead of a date.
export function CronReading({
  cron,
  enabled,
  now = new Date(),
  className,
}: {
  cron: string;
  enabled: boolean;
  now?: Date;
  className?: string;
}) {
  const t = useT();
  const reading = readCron(cron);
  const next = nextRun(cron, now);
  const unreadable = next === null;

  const sentence =
    reading === null
      ? null
      : reading.kind === "everyMinute"
        ? t("policies.cron.everyMinute")
        : reading.kind === "everyMinutes"
          ? t("policies.cron.everyMinutes", { every: String(reading.every) })
          : reading.kind === "hourly"
            ? t("policies.cron.hourly", { minute: String(reading.minute).padStart(2, "0") })
            : reading.kind === "everyHours"
              ? t("policies.cron.everyHours", { every: String(reading.every), minute: String(reading.minute).padStart(2, "0") })
              : reading.kind === "daily"
                ? t("policies.cron.daily", { time: clock(reading.hour, reading.minute) })
                : reading.kind === "weekly"
                  ? t("policies.cron.weekly", { day: weekday(reading.dayOfWeek), time: clock(reading.hour, reading.minute) })
                  : t("policies.cron.monthly", { day: String(reading.dayOfMonth), time: clock(reading.hour, reading.minute) });

  const nextText = !enabled
    ? t("policies.next.disabled")
    : unreadable
      ? t("policies.next.unreadable")
      : t("policies.next", { when: relativeDay(next, now, t) });

  return (
    <p data-testid="cron-reading" className={cn("font-mono text-subtle-foreground", unreadable && "text-caution", className)}>
      {sentence !== null ? `${sentence} · ` : ""}
      {nextText}
    </p>
  );
}

function clock(hour: number, minute: number): string {
  const d = new Date(2000, 0, 1, hour, minute);
  return formatTime(d.toISOString());
}

function weekday(dayOfWeek: number): string {
  // Sunday = 0; 4 Jan 2026 is a Sunday.
  const d = new Date(2026, 0, 4 + dayOfWeek);
  return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(d);
}

function relativeDay(at: Date, now: Date, t: ReturnType<typeof useT>): string {
  const day = dayGroupOf(at.toISOString(), now);
  const time = formatTime(at.toISOString());
  if (day.label === "today") return t("policies.next.today", { time });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day.key === dayGroupOf(tomorrow.toISOString(), now).key) return t("policies.next.tomorrow", { time });
  return formatDateTime(at.toISOString());
}
