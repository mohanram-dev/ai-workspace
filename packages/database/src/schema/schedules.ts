import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents, tasks } from "./agents";
import { users } from "./auth";
import { projects } from "./projects";

export const scheduleTrigger = pgEnum("schedule_trigger", ["cron", "interval", "daily", "weekly", "monthly", "once"]);
export const scheduleRunStatus = pgEnum("schedule_run_status", ["started", "skipped", "failed"]);

/** A recurring or one-time task an agent runs on its own (spec §26). */
export const schedules = pgTable(
  "schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    /** Null routes the task automatically, like a normal task. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    model: text("model"),
    /** IANA timezone the trigger is interpreted in. */
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    trigger: scheduleTrigger("trigger").notNull(),
    cron: text("cron"),
    intervalMinutes: integer("interval_minutes"),
    /** "HH:MM" in the schedule's timezone. */
    timeOfDay: text("time_of_day"),
    weekday: integer("weekday"),
    dayOfMonth: integer("day_of_month"),
    runAt: timestamp("run_at", { withTimezone: true }),
    /** When this schedule is next due. Null once a one-time schedule has run, or while disabled. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastTaskId: uuid("last_task_id").references(() => tasks.id, { onDelete: "set null" }),
    runCount: integer("run_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("schedule_user_idx").on(t.userId), index("schedule_due_idx").on(t.enabled, t.nextRunAt)],
);

/** One firing of a schedule, whether it started a task or not. */
export const scheduleRuns = pgTable(
  "schedule_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    status: scheduleRunStatus("status").notNull(),
    /** Why it was skipped or failed. */
    detail: text("detail"),
    /** The moment the run was due. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedule_run_schedule_idx").on(t.scheduleId, t.createdAt)],
);
