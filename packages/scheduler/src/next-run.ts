import { CronExpressionParser } from "cron-parser";
import type { ScheduleTrigger } from "@aiw/shared";

export interface TriggerSettings {
  trigger: ScheduleTrigger;
  timezone: string;
  cron?: string | null;
  intervalMinutes?: number | null;
  timeOfDay?: string | null;
  weekday?: number | null;
  dayOfMonth?: number | null;
  runAt?: Date | null;
}

export class InvalidTriggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTriggerError";
  }
}

/** Throws InvalidTriggerError when a timezone or cron expression cannot be used. */
export function assertValidTrigger(settings: TriggerSettings): void {
  if (!isValidTimezone(settings.timezone)) throw new InvalidTriggerError(`"${settings.timezone}" is not a known time zone.`);
  if (settings.trigger === "cron") {
    if (!settings.cron) throw new InvalidTriggerError("A cron schedule needs a cron expression.");
    try {
      CronExpressionParser.parse(settings.cron, { tz: settings.timezone });
    } catch {
      throw new InvalidTriggerError(`"${settings.cron}" is not a valid cron expression.`);
    }
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The next moment this schedule should run, strictly after `from`.
 * Returns null when it will never run again (a one-time schedule in the past).
 */
export function nextRunAt(settings: TriggerSettings, from: Date = new Date()): Date | null {
  assertValidTrigger(settings);
  switch (settings.trigger) {
    case "cron":
      return CronExpressionParser.parse(settings.cron!, { currentDate: from, tz: settings.timezone }).next().toDate();
    case "interval": {
      const minutes = settings.intervalMinutes;
      if (!minutes) throw new InvalidTriggerError("An interval schedule needs its interval.");
      return new Date(from.getTime() + minutes * 60_000);
    }
    case "once": {
      if (!settings.runAt) throw new InvalidTriggerError("A one-time schedule needs a date.");
      return settings.runAt.getTime() > from.getTime() ? settings.runAt : null;
    }
    case "daily":
    case "weekly":
    case "monthly":
      return nextCalendarRun(settings, from);
  }
}

const MAX_DAYS_AHEAD = 400;

/** Daily, weekly and monthly, resolved in the schedule's own timezone (so DST is respected). */
function nextCalendarRun(settings: TriggerSettings, from: Date): Date {
  const [hour, minute] = parseTimeOfDay(settings.timeOfDay);
  const today = zonedParts(from, settings.timezone);

  for (let offset = 0; offset <= MAX_DAYS_AHEAD; offset++) {
    const day = addDays(today, offset);
    if (settings.trigger === "weekly") {
      if (settings.weekday === undefined || settings.weekday === null) throw new InvalidTriggerError("A weekly schedule needs a weekday.");
      if (weekdayOf(day) !== settings.weekday) continue;
    }
    if (settings.trigger === "monthly") {
      if (!settings.dayOfMonth) throw new InvalidTriggerError("A monthly schedule needs a day of the month.");
      // A month shorter than the chosen day runs on its last day.
      const lastDay = daysInMonth(day.year, day.month);
      if (day.day !== Math.min(settings.dayOfMonth, lastDay)) continue;
    }
    const candidate = zonedTimeToUtc({ ...day, hour, minute }, settings.timezone);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  throw new InvalidTriggerError("This schedule never comes due.");
}

function parseTimeOfDay(value: string | null | undefined): [number, number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  if (!match) throw new InvalidTriggerError("This schedule needs a time of day like 08:30.");
  return [Number(match[1]), Number(match[2])];
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** The calendar date at `instant` as seen in `timezone`. */
function zonedParts(instant: Date, timezone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function addDays(date: DateParts, days: number): DateParts {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function weekdayOf(date: DateParts): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The instant at which a local wall-clock time occurs in a timezone. Solved by
 * measuring the zone's offset at a first guess and correcting, which handles
 * daylight-saving shifts.
 */
function zonedTimeToUtc(local: DateParts & { hour: number; minute: number }, timezone: string): Date {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let instant = new Date(asUtc - offsetAt(new Date(asUtc), timezone));
  // One correction is enough except near a transition, where a second settles it.
  instant = new Date(asUtc - offsetAt(instant, timezone));
  return instant;
}

/** Milliseconds the zone is ahead of UTC at that instant. */
function offsetAt(instant: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Plain-language summary shown in the UI. */
export function describeTrigger(settings: TriggerSettings): string {
  const zone = settings.timezone === "UTC" ? "UTC" : settings.timezone;
  switch (settings.trigger) {
    case "cron":
      return `Cron ${settings.cron} (${zone})`;
    case "interval": {
      const minutes = settings.intervalMinutes ?? 0;
      if (minutes % (60 * 24) === 0) return `Every ${minutes / (60 * 24)} day(s)`;
      if (minutes % 60 === 0) return `Every ${minutes / 60} hour(s)`;
      return `Every ${minutes} minutes`;
    }
    case "daily":
      return `Every day at ${settings.timeOfDay} (${zone})`;
    case "weekly":
      return `Every ${WEEKDAY_NAMES[settings.weekday ?? 0]} at ${settings.timeOfDay} (${zone})`;
    case "monthly":
      return `Day ${settings.dayOfMonth} of each month at ${settings.timeOfDay} (${zone})`;
    case "once":
      return settings.runAt ? `Once at ${settings.runAt.toISOString()}` : "Once";
  }
}
