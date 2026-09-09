// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The five-field cron the scheduler runs (minute hour day-of-month month day-of-week), read the
// way the scheduler reads it: `*`, lists, ranges and steps. The expression is the source of truth;
// what this module adds is the two things a reader cannot get from "0 2 * * *" at a glance — when
// it fires next, on their clock, and a plain-language reading for the shapes that have one. A
// shape with no reading returns null rather than a wrong sentence.

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
  // 7 is Sunday too, as in every cron since Vixie's.
  const sundaySafe = dayOfWeek.values.has(7) ? { values: new Set([...dayOfWeek.values, 0]), any: false } : dayOfWeek;
  return { minute, hour, dayOfMonth, month, dayOfWeek: sundaySafe };
}

function matches(field: Field, value: number): boolean {
  return field.any || field.values.has(value);
}

// Local time, minute resolution, like the wall clock the operator reads. Day-of-month and
// day-of-week combine the way cron does: when both are restricted, either one matching fires.
export function nextRun(expression: string, from: Date = new Date()): Date | null {
  const cron = parseCron(expression);
  if (cron === null) return null;
  const at = new Date(from.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (at.getTime() <= limit) {
    if (!matches(cron.month, at.getMonth() + 1)) {
      at.setMonth(at.getMonth() + 1, 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = matches(cron.dayOfMonth, at.getDate());
    const dowOk = matches(cron.dayOfWeek, at.getDay());
    const dayOk = cron.dayOfMonth.any || cron.dayOfWeek.any ? domOk && dowOk : domOk || dowOk;
    if (!dayOk) {
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matches(cron.hour, at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!matches(cron.minute, at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1, 0, 0);
      continue;
    }
    return at;
  }
  return null;
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
