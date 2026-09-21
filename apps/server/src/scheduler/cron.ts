// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// How this server reads a cron expression. One place, so the route that accepts a policy, the
// scheduler that runs it and the notifier that measures its cadence cannot disagree about whether
// an expression can be read, or about which clock it is read on.
//
// Two defects shaped it. The route validated a cron as a non-empty string, so "0 0 30 2 *" (30
// February) was stored with a 201 — and from the next tick cron-parser threw inside the
// scheduler's loop, which stopped every other policy from being dispatched and, because the
// notification passes ran after it in the same callback, every notification as well. And no call
// passed a zone, so every expression ran on the container's clock (UTC) while the interface read it
// on the operator's: a São Paulo operator's "0 2 * * *" ran at 23:00 their time.
//
// The grammar is the interface's: five fields, minute hour day-of-month month day-of-week.
// cron-parser also takes a leading seconds field, and a six-field expression can name a new window
// every second — which the scheduler would turn into a new job on every tick.

import { CronExpressionParser, type CronExpression } from "cron-parser";

export class UnreadableCronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableCronError";
  }
}

// February counts 29: an expression for the 29th fires in leap years, which is rare, not never.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

// cron-parser refuses a day of month the ONE month named cannot hold ("0 0 30 2 *"), but not the
// same impossibility spread over several ("0 0 31 4,6,9,11 *"). That one parses, its search then
// runs out of steps, and it hands back an instant the expression does not describe — measured on
// 5.6.2: 1962-04-21T23:59:59Z as the "most recent window", which the scheduler would have stored
// as a job. Only when day of week is `*`: a restricted day of week is OR'd with the day of month
// (Vixie cron's rule, and cron-parser's), so the expression still fires on those weekdays.
function canEverFire(expression: CronExpression): boolean {
  const { dayOfMonth, month, dayOfWeek } = expression.fields;
  if (dayOfMonth.isWildcard || dayOfMonth.hasLastChar || !dayOfWeek.isWildcard) return true;
  const earliest = Math.min(...dayOfMonth.values.filter((v) => v !== "L").map(Number));
  const longest = Math.max(...month.values.map((m) => DAYS_IN_MONTH[m - 1] ?? 31));
  return earliest <= longest;
}

function parse(cron: string, timeZone: string, currentDate: Date): CronExpression {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new UnreadableCronError(
      `a schedule has five fields (minute hour day-of-month month day-of-week); this one has ${fields.length}`,
    );
  }
  let expression: CronExpression;
  try {
    // hashSeed: cron-parser's `H` picks a value at random on every parse unless it is seeded, and
    // a window that moves on every tick is a new job on every tick. Seeded by the expression, the
    // same `H` lands on the same minute every time it is read.
    expression = CronExpressionParser.parse(cron, { currentDate, tz: timeZone, hashSeed: cron });
  } catch (err) {
    // The parser's own sentence, which names the part it refused. A cron field carries no secret,
    // so passing it through is not the leak routes/errors.ts guards against.
    const detail = err instanceof Error ? err.message : String(err);
    throw new UnreadableCronError(`the scheduler cannot read it: ${detail}`);
  }
  if (!canEverFire(expression)) {
    throw new UnreadableCronError("no month it lists has the day of month it names, so it would never fire");
  }
  return expression;
}

// Why the scheduler could not run this expression, as a sentence; null when it can. The route puts
// the sentence in the 400, under `cron`.
export function cronProblem(cron: string, timeZone: string, now: Date = new Date()): string | null {
  try {
    parse(cron, timeZone, now);
    return null;
  } catch (err) {
    return err instanceof UnreadableCronError ? err.message : String(err);
  }
}

// The most recent window at or before `now`, on the instance's clock. Throws UnreadableCronError.
export function currentWindow(cron: string, now: Date, timeZone: string): Date {
  return parse(cron, timeZone, now).prev().toDate();
}

// The first window after `now`, on the instance's clock. Throws UnreadableCronError.
export function nextWindow(cron: string, now: Date, timeZone: string): Date {
  return parse(cron, timeZone, now).next().toDate();
}
