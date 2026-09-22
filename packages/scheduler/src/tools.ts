import {
  createSchedule,
  getTask,
  listAgentsForUser,
  listSchedulesForUser,
  updateScheduleForUser,
  type Database,
} from "@aiw/database";
import { isValidTimeZone, SCHEDULE_TRIGGERS, timeOfDaySchema, type ScheduleTrigger } from "@aiw/shared";
import { ToolError, type AnyToolDefinition } from "@aiw/tools";
import { z } from "zod";
import { describeTrigger, nextRunAt, type TriggerSettings } from "./next-run";

const TOOL_TIMEOUT_MS = 10_000;

/**
 * Nothing may be scheduled to run more often than this. A model that mishears
 * "every morning" as "every minute" would otherwise spend real money all night,
 * and the mistake is only visible the next day.
 */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 15;

/** Schedules one user may have. A ceiling, not a quota anyone should reach. */
export const MAX_SCHEDULES_PER_USER = 25;

export interface ScheduleToolOptions {
  db: Database;
  minIntervalMinutes?: number;
  maxPerUser?: number;
}

const createInput = z.object({
  name: z.string().trim().min(1).max(80).describe("Short name for the schedule, e.g. \"AI news digest\""),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe("The complete instruction the agent will be given each run. It cannot see this conversation, so include everything."),
  trigger: z.enum(SCHEDULE_TRIGGERS),
  timeOfDay: timeOfDaySchema.optional().describe("HH:MM for daily, weekly and monthly schedules"),
  weekday: z.number().int().min(0).max(6).optional().describe("0 = Sunday, for weekly schedules"),
  dayOfMonth: z.number().int().min(1).max(31).optional().describe("For monthly schedules"),
  intervalMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
  cron: z.string().trim().min(1).max(120).optional(),
  runAt: z.string().trim().min(1).max(40).optional().describe("ISO timestamp, for a one-time schedule"),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe("IANA name such as Asia/Kolkata. Ask the user rather than guessing; omitted means the zone their other schedules use."),
  agent: z.string().trim().min(1).max(60).optional().describe("Slug of the agent to run it, e.g. research. Omitted means this task's agent."),
  model: z.string().trim().min(1).max(200).optional(),
});

type CreateInput = z.infer<typeof createInput>;

/**
 * Lets an agent set up a schedule from a sentence — "every weekday at 7:30,
 * search the news and write a file" — instead of the person filling a form
 * (spec §26).
 *
 * `schedule.create` is DESTRUCTIVE on purpose. It is the only tool that commits
 * the workspace to running, and spending, while nobody is watching; a wrong
 * time or a runaway interval is discovered the next morning. The approval card
 * shows the trigger in words and the first run time, so one look catches it.
 */
export function createScheduleTools(options: ScheduleToolOptions): AnyToolDefinition[] {
  const { db } = options;
  const minInterval = options.minIntervalMinutes ?? MIN_SCHEDULE_INTERVAL_MINUTES;
  const maxPerUser = options.maxPerUser ?? MAX_SCHEDULES_PER_USER;

  const owner = async (taskId: string) => {
    const task = await getTask(db, taskId);
    if (!task) throw new ToolError("unavailable", "This task no longer exists.");
    return task;
  };

  const tools: AnyToolDefinition[] = [
    {
      name: "schedule.create",
      description:
        "Create a repeating schedule that runs an agent on its own: daily, weekly, monthly, on an interval, on a cron expression, or once. Use it when the user asks for something to happen regularly or at a future time. Give a complete prompt — the scheduled run cannot see this conversation — and ask the user for their time zone if you do not already know it.",
      category: "schedule",
      inputSchema: createInput,
      permission: "DESTRUCTIVE",
      timeoutMs: TOOL_TIMEOUT_MS,
      availability: () => ({ available: true }),
      execute: async (input: CreateInput, context) => {
        const task = await owner(context.taskId);
        const existing = await listSchedulesForUser(db, task.userId);
        if (existing.length >= maxPerUser) {
          throw new ToolError("permission_denied", `There are already ${existing.length} schedules, which is the limit. Delete one first.`);
        }

        // The agent has no way to know the person's time zone, so it is asked
        // for, or inherited from the schedules they already made.
        const timezone = input.timezone ?? existing.at(-1)?.timezone ?? "UTC";
        if (!isValidTimeZone(timezone)) {
          throw new ToolError("invalid_input", `"${timezone}" is not a time zone this server knows. Use an IANA name such as Asia/Kolkata.`);
        }

        const agentId = await resolveAgentId(db, task.userId, input.agent, task.agentId);
        const runAt = input.runAt ? new Date(input.runAt) : null;
        if (input.runAt && Number.isNaN(runAt!.getTime())) {
          throw new ToolError("invalid_input", `"${input.runAt}" is not a valid timestamp.`);
        }

        const settings: TriggerSettings = {
          trigger: input.trigger,
          timezone,
          cron: input.cron ?? null,
          intervalMinutes: input.intervalMinutes ?? null,
          timeOfDay: input.timeOfDay ?? null,
          weekday: input.weekday ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
          runAt,
        };

        let first: Date | null;
        try {
          first = nextRunAt(settings);
        } catch (error) {
          throw new ToolError("invalid_input", (error as Error).message);
        }
        if (!first) throw new ToolError("invalid_input", "That schedule would never run. A one-time schedule needs a time in the future.");

        assertNotTooFrequent(settings, first, minInterval);

        const created = await createSchedule(db, {
          userId: task.userId,
          name: input.name,
          prompt: input.prompt,
          agentId,
          projectId: task.projectId,
          model: input.model ?? null,
          timezone,
          trigger: input.trigger,
          cron: settings.cron,
          intervalMinutes: settings.intervalMinutes,
          timeOfDay: settings.timeOfDay,
          weekday: settings.weekday,
          dayOfMonth: settings.dayOfMonth,
          runAt: settings.runAt,
          nextRunAt: first,
          enabled: true,
        });

        const summary = `${describeTrigger(settings)}, first run ${first.toISOString()}`;
        return {
          output: { id: created.id, name: created.name, timezone, trigger: input.trigger, nextRunAt: first.toISOString() },
          summary: `Scheduled "${created.name}": ${describeTrigger(settings)}`,
          content: `Created the schedule "${created.name}". ${summary}. It runs on its own from now on; the user can change or delete it on the Schedules page.`,
        };
      },
    },
    {
      name: "schedule.list",
      description: "List the user's schedules, with when each one next runs. Use it before creating a schedule that might already exist, or to answer what is set up.",
      category: "schedule",
      inputSchema: z.object({}),
      permission: "READ",
      timeoutMs: TOOL_TIMEOUT_MS,
      availability: () => ({ available: true }),
      execute: async (_input: Record<string, never>, context) => {
        const task = await owner(context.taskId);
        const schedules = await listSchedulesForUser(db, task.userId);
        const rows = schedules.map((s) => ({
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          timezone: s.timezone,
          when: describeTrigger(triggerOf(s)),
          nextRunAt: s.nextRunAt?.toISOString() ?? null,
          agent: s.agentName,
        }));
        return {
          output: { schedules: rows },
          summary: `${rows.length} schedule${rows.length === 1 ? "" : "s"}`,
          content: rows.length === 0 ? "There are no schedules yet." : rows.map((r) => `- ${r.name} — ${r.when} (${r.timezone})${r.enabled ? "" : " [disabled]"}`).join("\n"),
        };
      },
    },
    {
      name: "schedule.disable",
      description: "Turn a schedule off without deleting it, by its id from schedule.list. Deleting is left to the user.",
      category: "schedule",
      inputSchema: z.object({ id: z.uuid(), reason: z.string().trim().max(200).optional() }),
      permission: "WRITE",
      timeoutMs: TOOL_TIMEOUT_MS,
      availability: () => ({ available: true }),
      execute: async (input: { id: string; reason?: string }, context) => {
        const task = await owner(context.taskId);
        const updated = await updateScheduleForUser(db, task.userId, input.id, { enabled: false });
        if (!updated) throw new ToolError("not_found", "There is no schedule with that id.");
        return {
          output: { id: updated.id, name: updated.name, enabled: false },
          summary: `Disabled "${updated.name}"`,
          content: `"${updated.name}" is now off and will not run until it is switched back on.`,
        };
      },
    },
  ];

  return tools;
}

export const SCHEDULE_TOOL_NAMES = ["schedule.create", "schedule.list", "schedule.disable"] as const;

function triggerOf(s: {
  trigger: ScheduleTrigger;
  timezone: string;
  cron: string | null;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  weekday: number | null;
  dayOfMonth: number | null;
  runAt: Date | null;
}): TriggerSettings {
  return s;
}

/** Resolves an agent slug to an id, falling back to the agent running this task. */
async function resolveAgentId(db: Database, userId: string, slug: string | undefined, fallback: string | null): Promise<string | null> {
  if (!slug) return fallback;
  const agents = await listAgentsForUser(db, userId);
  const wanted = slug.trim().toLowerCase();
  const match = agents.find((a) => a.enabled && (a.slug.toLowerCase() === wanted || a.name.toLowerCase() === wanted || a.id === slug));
  if (!match) {
    throw new ToolError("not_found", `There is no enabled agent called "${slug}". Available: ${agents.filter((a) => a.enabled).map((a) => a.slug).join(", ")}.`);
  }
  return match.id;
}

/**
 * Refuses anything that would fire more often than the floor. Interval is
 * checked directly; every other trigger is measured by the gap between its
 * first two occurrences, which catches a cron expression like the
 * every-minute `* * * * *` without having to interpret it.
 */
function assertNotTooFrequent(settings: TriggerSettings, first: Date, minMinutes: number): void {
  const tooOften = (minutes: number) =>
    new ToolError(
      "invalid_input",
      `That would run every ${Math.round(minutes)} minutes. Nothing may be scheduled more often than every ${minMinutes} minutes — ask the user to confirm a longer gap.`,
    );

  if (settings.trigger === "interval") {
    const minutes = settings.intervalMinutes ?? 0;
    if (minutes < minMinutes) throw tooOften(minutes);
    return;
  }
  if (settings.trigger === "once") return;

  const second = nextRunAt(settings, first);
  if (!second) return;
  const gapMinutes = (second.getTime() - first.getTime()) / 60_000;
  if (gapMinutes < minMinutes) throw tooOften(gapMinutes);
}
