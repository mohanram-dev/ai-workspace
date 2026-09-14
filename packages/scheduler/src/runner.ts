import {
  claimDueSchedule,
  insertScheduleRun,
  listDueSchedules,
  updateScheduleForUser,
  type Database,
  type Schedule,
} from "@aiw/database";
import { nextRunAt, type TriggerSettings } from "./next-run";

/** What the runner needs from the task service, kept narrow so it can be tested. */
export interface ScheduleTaskStarter {
  createTask(
    userId: string,
    input: { prompt: string; agentId?: string | undefined; model?: string | undefined; projectId?: string | undefined },
  ): Promise<{ task: { id: string } }>;
}

export interface SchedulerOptions {
  db: Database;
  tasks: ScheduleTaskStarter;
  /** How often to look for due schedules. */
  tickMs?: number;
  /** Schedules started per tick. */
  batchSize?: number;
  now?: () => Date;
}

const DEFAULT_TICK_MS = 30_000;

export function triggerSettingsOf(schedule: Schedule): TriggerSettings {
  return {
    trigger: schedule.trigger,
    timezone: schedule.timezone,
    cron: schedule.cron,
    intervalMinutes: schedule.intervalMinutes,
    timeOfDay: schedule.timeOfDay,
    weekday: schedule.weekday,
    dayOfMonth: schedule.dayOfMonth,
    runAt: schedule.runAt,
  };
}

/**
 * Runs due schedules (spec §26). One process owns the ticker; each schedule is
 * claimed with a conditional update, so a second runner cannot double-fire it.
 * Phase 12 moves this onto the queue with the rest of execution.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tickMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(private readonly options: SchedulerOptions) {
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.batchSize = options.batchSize ?? 10;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts every schedule that is due. Returns how many fired. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let started = 0;
    try {
      const due = await listDueSchedules(this.options.db, this.now(), this.batchSize);
      for (const schedule of due) {
        if (await this.fire(schedule)) started++;
      }
    } catch (error) {
      console.error("Scheduler tick failed", error);
    } finally {
      this.running = false;
    }
    return started;
  }

  /** Claims one schedule and starts its task. Returns false when another runner had it. */
  private async fire(schedule: Schedule): Promise<boolean> {
    const { db } = this.options;
    const dueAt = schedule.nextRunAt;
    if (!dueAt) return false;

    let following: Date | null = null;
    try {
      // Compute from the due time so a late tick does not skip an occurrence.
      following = schedule.trigger === "once" ? null : nextRunAt(triggerSettingsOf(schedule), dueAt);
    } catch (error) {
      // A schedule that cannot be scheduled again is disabled rather than retried forever.
      await updateScheduleForUser(db, schedule.userId, schedule.id, { enabled: false, nextRunAt: null });
      await insertScheduleRun(db, {
        scheduleId: schedule.id,
        userId: schedule.userId,
        status: "failed",
        detail: `The schedule was disabled: ${(error as Error).message}`,
        scheduledFor: dueAt,
      });
      return false;
    }

    const claimed = await claimDueSchedule(db, schedule.id, dueAt, following);
    if (!claimed) return false;

    try {
      const created = await this.options.tasks.createTask(schedule.userId, {
        prompt: schedule.prompt,
        ...(schedule.agentId ? { agentId: schedule.agentId } : {}),
        ...(schedule.model ? { model: schedule.model } : {}),
        ...(schedule.projectId ? { projectId: schedule.projectId } : {}),
      });
      await updateScheduleForUser(db, schedule.userId, schedule.id, { lastTaskId: created.task.id });
      await insertScheduleRun(db, {
        scheduleId: schedule.id,
        userId: schedule.userId,
        taskId: created.task.id,
        status: "started",
        scheduledFor: dueAt,
      });
      return true;
    } catch (error) {
      // Busy or misconfigured: record it and wait for the next occurrence.
      const message = error instanceof Error ? error.message : "The task could not be started.";
      await insertScheduleRun(db, {
        scheduleId: schedule.id,
        userId: schedule.userId,
        status: "skipped",
        detail: message,
        scheduledFor: dueAt,
      });
      return false;
    }
  }
}
