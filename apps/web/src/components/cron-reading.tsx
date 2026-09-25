// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useI18n, useT, type Locale } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { namesAClockTime, nextRun, parseCron, readCron, sameWallClock, type CronReading as Reading } from "@/lib/cron";
import { dayGroupOf } from "@/lib/format";
import { useFormat, type Format } from "@/lib/use-format";

// The two things a cron expression does not say on its own: what it means in words, when the
// shape has an honest sentence, and when it fires next. A disabled policy has no next run and says
// so; an expression the scheduler cannot read says that instead of a date.
//
// Two clocks, and the line keeps them apart. The expression is read on the INSTANCE's
// (SCHRODUMP_TZ), and the sentence names it — "every day at 2:00 AM UTC" — because that is the
// clock the scheduler runs it on. The next run is an instant, and like every timestamp in this
// interface it renders on the viewer's clock, marked as theirs when the two read differently.
// Before the zone is known the line names no clock time at all: a time without its zone is how a
// São Paulo operator was told 02:00 for a job that ran at 23:00.
export function CronReading({
  cron,
  enabled,
  timeZone,
  nextRunAt,
  now = new Date(),
  className,
}: {
  cron: string;
  enabled: boolean;
  // The instance's zone, from GET /me. null while it is unknown.
  timeZone: string | null;
  // A saved policy's next run as the server computed it — null when disabled or unreadable.
  // Absent for the form's live preview, which computes it here on the instance's clock.
  nextRunAt?: string | null;
  now?: Date;
  className?: string;
}) {
  const t = useT();
  const { locale } = useI18n();
  const fmt = useFormat();
  const reading = readCron(cron);
  const live = nextRunAt === undefined;
  // For a saved policy the scheduler's own answer decides: it is the one that refuses what it
  // cannot run, and it may read a shape this module has no grammar for.
  const unreadable = live ? parseCron(cron) === null : enabled && nextRunAt === null;
  const next = live
    ? timeZone === null
      ? null
      : nextRun(cron, now, timeZone)
    : nextRunAt === null
      ? null
      : new Date(nextRunAt);

  // The zone goes on every sentence that names a clock time, and stands alone when the shape has
  // no sentence — "0 2 * * 1-5" is still read on the instance's clock, and the line says so.
  let sentence: string | null = null;
  if (!unreadable && timeZone !== null) {
    sentence =
      reading === null
        ? t("policies.cron.zoneOnly", { zone: timeZone })
        : namesAClockTime(reading)
          ? t("policies.cron.inZone", { reading: describe(reading, t, locale, fmt), zone: timeZone })
          : describe(reading, t, locale, fmt);
  } else if (!unreadable && reading !== null && !namesAClockTime(reading)) {
    // "every 15 minutes" is the same on every clock, so it can be said before the zone is known.
    sentence = describe(reading, t, locale, fmt);
  }

  const nextText = !enabled
    ? t("policies.next.disabled")
    : unreadable
      ? t("policies.next.unreadable")
      : next === null
        ? null
        : timeZone !== null && !sameWallClock(next, timeZone)
          ? t("policies.next.viewerClock", { when: relativeDay(next, now, t, fmt) })
          : t("policies.next", { when: relativeDay(next, now, t, fmt) });

  const parts = [sentence, nextText].filter((part): part is string => part !== null);

  return (
    <p data-testid="cron-reading" className={cn("font-mono text-subtle-foreground", unreadable && "text-caution", className)}>
      {parts.join(" · ")}
    </p>
  );
}

function describe(reading: Reading, t: ReturnType<typeof useT>, locale: Locale, fmt: Format): string {
  switch (reading.kind) {
    case "everyMinute":
      return t("policies.cron.everyMinute");
    case "everyMinutes":
      return t("policies.cron.everyMinutes", { every: String(reading.every) });
    case "hourly":
      return t("policies.cron.hourly", { minute: String(reading.minute).padStart(2, "0") });
    case "everyHours":
      return t("policies.cron.everyHours", { every: String(reading.every), minute: String(reading.minute).padStart(2, "0") });
    case "daily":
      return t("policies.cron.daily", { time: clock(reading.hour, reading.minute, fmt) });
    case "weekly":
      return t("policies.cron.weekly", { day: weekday(reading.dayOfWeek, locale), time: clock(reading.hour, reading.minute, fmt) });
    case "monthly":
      return t("policies.cron.monthly", { day: String(reading.dayOfMonth), time: clock(reading.hour, reading.minute, fmt) });
  }
}

// An hour and minute as the viewer's locale writes a time of day. Built on a local Date only to
// borrow the locale's format: the hour is the expression's, not converted to any clock.
function clock(hour: number, minute: number, fmt: Format): string {
  const d = new Date(2000, 0, 1, hour, minute);
  return fmt.time(d.toISOString());
}

function weekday(dayOfWeek: number, locale: Locale): string {
  // Sunday = 0; 4 Jan 2026 is a Sunday.
  const d = new Date(2026, 0, 4 + dayOfWeek);
  return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(d);
}

function relativeDay(at: Date, now: Date, t: ReturnType<typeof useT>, fmt: Format): string {
  const day = dayGroupOf(at.toISOString(), now);
  const time = fmt.time(at.toISOString());
  if (day.label === "today") return t("policies.next.today", { time });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day.key === dayGroupOf(tomorrow.toISOString(), now).key) return t("policies.next.tomorrow", { time });
  return fmt.dateTime(at.toISOString());
}
