// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The five-field cron the scheduler runs (minute hour day-of-month month day-of-week), read the
// way the scheduler reads it: `*`, lists, ranges and steps. The expression is the source of truth;
// what this module adds is the two things a reader cannot get from "0 2 * * *" at a glance — when
// it fires next, and a plain-language reading for the shapes that have one. A shape with no
// reading returns null rather than a wrong sentence.
//
// Whose clock: the INSTANCE's (SCHRODUMP_TZ, which GET /me carries), never the viewer's. This
// module used to walk the browser's clock while the scheduler ran on the container's UTC, so a
// São Paulo operator read "next tomorrow 02:00" for a job that ran at 23:00 their time. For a
// saved policy the server's own `nextRunAt` is the answer and nothing here computes it; nextRun
// is the form's live preview of an expression not yet saved.

interface Field {
  readonly values: ReadonlySet<number>;
  readonly any: boolean;
}

export interface CronFields {
  readonly minute: Field;
  readonly hour: Field;
  readonly dayOfMonth: Field;
  readonly month: Field;
  readonly dayOfWeek: Field;
}

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 7],
} as const;

// February counts 29: an expression for the 29th fires in leap years, which is rare, not never.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

function parseField(raw: string, [min, max]: readonly [number, number]): Field | null {
  if (raw === "*") return { values: new Set(), any: true };
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    if (rangePart === undefined || rangePart.length === 0) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b)) return null;
      lo = a;
      hi = b;
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return null;
      lo = n;
      hi = stepPart === undefined ? n : max;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any: false };
}

export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0] ?? "", RANGES.minute);
  const hour = parseField(parts[1] ?? "", RANGES.hour);
  const dayOfMonth = parseField(parts[2] ?? "", RANGES.dayOfMonth);
  const month = parseField(parts[3] ?? "", RANGES.month);
  const dayOfWeek = parseField(parts[4] ?? "", RANGES.dayOfWeek);
  if (minute === null || hour === null || dayOfMonth === null || month === null || dayOfWeek === null) return null;
  // A day of month that no listed month has — 30 February, 31 April — is an expression that never
  // fires, and the scheduler refuses it: the server answers 400 on `cron`, and a policy stored
  // before that check existed is skipped on every tick. Refusing it here is what blocks Save on the
  // form's "unreadable" path instead of letting the operator meet the 400. Only when day of week is
  // `*`: a restricted day of week is OR'd with the day of month, so the expression still fires.
  if (!dayOfMonth.any && dayOfWeek.any) {
    const earliest = Math.min(...dayOfMonth.values);
    const months = month.any ? ALL_MONTHS : [...month.values];
    const longest = Math.max(...months.map((m) => DAYS_IN_MONTH[m - 1] ?? 31));
    if (earliest > longest) return null;
  }
  // 7 is Sunday too, as in every cron since Vixie's.
  const sundaySafe = dayOfWeek.values.has(7) ? { values: new Set([...dayOfWeek.values, 0]), any: false } : dayOfWeek;
  return { minute, hour, dayOfMonth, month, dayOfWeek: sundaySafe };
}

function matches(field: Field, value: number): boolean {
  return field.any || field.values.has(value);
}

// --- the instance's clock ---------------------------------------------------------------------
//
// The walk below runs on a WALL CLOCK encoded as a UTC Date — year, month, day, hour and minute in
// the zone, read and set with the UTC accessors — so the browser's own zone cannot leak into it.
// Only the two ends touch Intl: reading `from` on the zone's clock, and turning the match back
// into an instant. formatToParts is the one Intl call, and a formatter per zone is kept.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// `at` on `timeZone`'s wall clock, to the minute, as a UTC-encoded Date.
function wallClockOf(at: Date, timeZone: string): Date {
  const parts = formatterFor(timeZone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute")));
}

// The instant a wall-clock time names in `timeZone`. Two readings of the zone's offset settle it,
// DST edges included; a wall time the zone skips (the hour the clocks spring forward over) has no
// instant, and resolves to the later candidate — past the jump, where cron-parser lands too.
function instantOf(wall: Date, timeZone: string): Date {
  const target = wall.getTime();
  const offsetAt = (ms: number): number => wallClockOf(new Date(ms), timeZone).getTime() - ms;
  const first = target - offsetAt(target);
  const second = target - offsetAt(first);
  if (wallClockOf(new Date(second), timeZone).getTime() === target) return new Date(second);
  return new Date(Math.max(first, second));
}

// Whether `at` reads the same on `timeZone`'s clock as on the viewer's. When it does not, the
// policy row says which clock its next-run time is on.
export function sameWallClock(at: Date, timeZone: string): boolean {
  try {
    return wallClockOf(at, timeZone).getTime() === wallClockOf(at, viewerZone()).getTime();
  } catch {
    return true;
  }
}

// Eight years: the longest gap between two 29ths of February in the Gregorian calendar (2096 to
// 2104). Any expression parseCron accepts fires within it.
const HORIZON_MS = 8 * 366 * 24 * 60 * 60 * 1000;

// The first firing after `from` on `timeZone`'s clock (the viewer's own when absent), to the
// minute. Day-of-month and day-of-week combine the way cron does: when both are restricted, either
// one matching fires. null for an expression parseCron refuses — and for a zone this browser does
// not know, which is an answer the preview cannot give rather than a schedule that does not parse.
export function nextRun(expression: string, from: Date = new Date(), timeZone?: string): Date | null {
  const cron = parseCron(expression);
  if (cron === null) return null;
  try {
    const zone = timeZone ?? viewerZone();
    const at = wallClockOf(from, zone);
    at.setUTCMinutes(at.getUTCMinutes() + 1);
    const limit = at.getTime() + HORIZON_MS;
    while (at.getTime() <= limit) {
      if (!matches(cron.month, at.getUTCMonth() + 1)) {
        at.setUTCMonth(at.getUTCMonth() + 1, 1);
        at.setUTCHours(0, 0, 0, 0);
        continue;
      }
      const domOk = matches(cron.dayOfMonth, at.getUTCDate());
      const dowOk = matches(cron.dayOfWeek, at.getUTCDay());
      const dayOk = cron.dayOfMonth.any || cron.dayOfWeek.any ? domOk && dowOk : domOk || dowOk;
      if (!dayOk) {
        at.setUTCDate(at.getUTCDate() + 1);
        at.setUTCHours(0, 0, 0, 0);
        continue;
      }
      if (!matches(cron.hour, at.getUTCHours())) {
        at.setUTCHours(at.getUTCHours() + 1, 0, 0, 0);
        continue;
      }
      if (!matches(cron.minute, at.getUTCMinutes())) {
        at.setUTCMinutes(at.getUTCMinutes() + 1, 0, 0);
        continue;
      }
      const instant = instantOf(at, zone);
      // The hour the clocks fall back over reads twice; a match on its first pass can land at or
      // before `from`, and the next firing is further on.
      if (instant.getTime() > from.getTime()) return instant;
      at.setUTCMinutes(at.getUTCMinutes() + 1, 0, 0);
    }
    return null;
  } catch {
    return null;
  }
}

// The shapes an operator actually writes. Anything else is left to the expression itself.
export type CronReading =
  | { kind: "everyMinute" }
  | { kind: "everyMinutes"; every: number }
  | { kind: "hourly"; minute: number }
  | { kind: "everyHours"; every: number; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; dayOfWeek: number; hour: number; minute: number }
  | { kind: "monthly"; dayOfMonth: number; hour: number; minute: number };

function single(field: Field): number | null {
  return !field.any && field.values.size === 1 ? [...field.values][0]! : null;
}

function stepOf(field: Field, max: number): number | null {
  if (field.any || field.values.size < 2) return null;
  const sorted = [...field.values].sort((a, b) => a - b);
  const step = sorted[1]! - sorted[0]!;
  if (sorted[0] !== 0 || step < 1) return null;
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! - sorted[i - 1]! !== step) return null;
  return sorted[sorted.length - 1]! + step > max ? step : null;
}

export function readCron(expression: string): CronReading | null {
  const cron = parseCron(expression);
  if (cron === null) return null;
  const { minute, hour, dayOfMonth, month, dayOfWeek } = cron;
  if (!month.any) return null;
  const m = single(minute);
  const h = single(hour);
  if (dayOfMonth.any && dayOfWeek.any) {
    if (minute.any && hour.any) return { kind: "everyMinute" };
    const everyMinutes = stepOf(minute, 59);
    if (everyMinutes !== null && hour.any) return { kind: "everyMinutes", every: everyMinutes };
    if (m !== null && hour.any) return { kind: "hourly", minute: m };
    const everyHours = stepOf(hour, 23);
    if (m !== null && everyHours !== null) return { kind: "everyHours", every: everyHours, minute: m };
    if (m !== null && h !== null) return { kind: "daily", hour: h, minute: m };
    return null;
  }
  if (m === null || h === null) return null;
  const dow = single(dayOfWeek);
  if (dayOfMonth.any && dow !== null) return { kind: "weekly", dayOfWeek: dow === 7 ? 0 : dow, hour: h, minute: m };
  const dom = single(dayOfMonth);
  if (dayOfWeek.any && dom !== null) return { kind: "monthly", dayOfMonth: dom, hour: h, minute: m };
  return null;
}

// Whether a reading names a time on a clock — and so means nothing without saying whose. "Every
// 15 minutes" is the same on every clock; "every day at 02:00" is not.
export function namesAClockTime(reading: CronReading): boolean {
  return reading.kind !== "everyMinute" && reading.kind !== "everyMinutes";
}
