import type { Schedule, ScheduleRun, ScheduleWithNames } from "@aiw/database";
import { describeTrigger, InvalidTriggerError, nextRunAt, triggerSettingsOf, type TriggerSettings } from "@aiw/scheduler";
import type { ScheduleDto, ScheduleRunDto } from "@aiw/shared";
import { HttpError } from "./http";

export { getScheduler } from "@aiw/runtime";

export function toScheduleDto(row: ScheduleWithNames): ScheduleDto {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    agent: row.agentId ? { id: row.agentId, name: row.agentName ?? "Agent" } : null,
    projectId: row.projectId,
    projectName: row.projectName,
    model: row.model,
    timezone: row.timezone,
    enabled: row.enabled,
    trigger: row.trigger,
    cron: row.cron,
    intervalMinutes: row.intervalMinutes,
    timeOfDay: row.timeOfDay,
    weekday: row.weekday,
    dayOfMonth: row.dayOfMonth,
    runAt: row.runAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastTaskId: row.lastTaskId,
    runCount: row.runCount,
    description: describeTrigger(triggerSettingsOf(row as Schedule)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toScheduleRunDto(row: ScheduleRun): ScheduleRunDto {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    taskId: row.taskId,
    status: row.status,
    detail: row.detail,
    scheduledFor: row.scheduledFor.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Computes the next run, turning an unusable trigger into a 400 rather than a 500. */
export function computeNextRun(settings: TriggerSettings, from: Date = new Date()): Date | null {
  try {
    return nextRunAt(settings, from);
  } catch (error) {
    if (error instanceof InvalidTriggerError || (error as Error)?.name === "InvalidTriggerError") {
      throw new HttpError(400, "bad_request", (error as Error).message);
    }
    throw error;
  }
}
