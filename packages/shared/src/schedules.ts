import { z } from "zod";
import { MAX_MESSAGE_LENGTH } from "./chat";

export const SCHEDULE_TRIGGERS = ["cron", "interval", "daily", "weekly", "monthly", "once"] as const;
export type ScheduleTrigger = (typeof SCHEDULE_TRIGGERS)[number];

/**
 * `started` means the task was launched and is still going. The three outcomes
 * are written back when it finishes, so a run history answers the question an
 * unattended schedule actually raises: did it work? `skipped` and `failed` are
 * the scheduler's own outcomes — the task never started at all.
 */
export const SCHEDULE_RUN_STATUSES = ["started", "completed", "errored", "cancelled", "skipped", "failed"] as const;
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];

/** Run statuses that mean the schedule did not produce a result. */
export const UNSUCCESSFUL_RUN_STATUSES: readonly ScheduleRunStatus[] = ["errored", "cancelled", "skipped", "failed"];

/**
 * Whether the runtime knows this time zone.
 *
 * Deliberately `Intl` rather than `Intl.supportedValuesOf("timeZone")`, which
 * lists only canonical names: that list holds "Asia/Calcutta" but not
 * "Asia/Kolkata", so it would reject the name most people would type. `Intl`
 * accepts common aliases and abbreviations too ("IST" resolves to
 * Asia/Calcutta), and rejects what is actually broken — a typo like
 * "Asia/Kolkatta", or an offset like "GMT+5:30". Those used to be stored
 * happily and then threw when the next occurrence was computed, which disables
 * the schedule.
 */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" in the schedule's own timezone. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:30.");

/** A cron expression with five fields: minute hour day-of-month month day-of-week. */
export const cronSchema = z
  .string()
  .trim()
  .min(9)
  .max(120)
  .regex(/^[\d*/,\-A-Za-z? ]+$/, "That does not look like a cron expression.");

const triggerFields = {
  /** Required for the cron trigger. */
  cron: cronSchema.optional(),
  /** Required for interval: how often to run. */
  intervalMinutes: z.number().int().min(5).max(60 * 24 * 30).optional(),
  /** Required for daily, weekly and monthly. */
  timeOfDay: timeOfDaySchema.optional(),
  /** 0 = Sunday … 6 = Saturday (weekly). */
  weekday: z.number().int().min(0).max(6).optional(),
  /** 1–31; a month shorter than this runs on its last day (monthly). */
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  /** When to run a one-time schedule (ISO instant). */
  runAt: z.string().datetime({ offset: true }).optional(),
};

const baseSchedule = {
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  agentId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  model: z.string().min(1).max(200).nullish(),
  /** IANA timezone, e.g. "Europe/London" or "Asia/Kolkata". */
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, { message: 'Unknown time zone. Use an IANA name such as "Asia/Kolkata" or "Europe/London".' })
    .default("UTC"),
  enabled: z.boolean().default(true),
  trigger: z.enum(SCHEDULE_TRIGGERS),
  ...triggerFields,
};

/** Each trigger needs its own field; this keeps a schedule from being half-configured. */
function checkTrigger(value: { trigger: ScheduleTrigger } & Partial<Record<keyof typeof triggerFields, unknown>>): boolean {
  switch (value.trigger) {
    case "cron":
      return typeof value.cron === "string";
    case "interval":
      return typeof value.intervalMinutes === "number";
    case "daily":
      return typeof value.timeOfDay === "string";
    case "weekly":
      return typeof value.timeOfDay === "string" && typeof value.weekday === "number";
    case "monthly":
      return typeof value.timeOfDay === "string" && typeof value.dayOfMonth === "number";
    case "once":
      return typeof value.runAt === "string";
  }
}

const TRIGGER_MESSAGE = "That trigger needs its own setting (cron expression, interval, time of day, weekday, day of month or a date).";

export const createScheduleSchema = z.object(baseSchedule).refine(checkTrigger, { message: TRIGGER_MESSAGE });
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = z
  .object({ ...baseSchedule, timezone: baseSchedule.timezone.unwrap(), enabled: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" })
  .refine((v) => v.trigger === undefined || checkTrigger(v as { trigger: ScheduleTrigger }), { message: TRIGGER_MESSAGE });
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;

export interface ScheduleDto {
  id: string;
  name: string;
  prompt: string;
  agent: { id: string; name: string } | null;
  projectId: string | null;
  projectName: string | null;
  model: string | null;
  timezone: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  cron: string | null;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  weekday: number | null;
  dayOfMonth: number | null;
  runAt: string | null;
  /** Null when the schedule is disabled or a one-time schedule already ran. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: string | null;
  runCount: number;
  /** Plain-language summary of the trigger, e.g. "Every day at 08:00 (UTC)". */
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRunDto {
  id: string;
  scheduleId: string;
  taskId: string | null;
  status: ScheduleRunStatus;
  /** Why a run was skipped or failed. */
  detail: string | null;
  /** The time the run was due, which can differ slightly from when it started. */
  scheduledFor: string;
  createdAt: string;
}

export interface ScheduleWithRunsDto extends ScheduleDto {
  runs: ScheduleRunDto[];
}
