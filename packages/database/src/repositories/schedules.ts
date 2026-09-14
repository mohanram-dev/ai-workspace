import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agents, projects, scheduleRuns, schedules } from "../schema";

export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;
export type ScheduleRun = typeof scheduleRuns.$inferSelect;
export type NewScheduleRun = typeof scheduleRuns.$inferInsert;

export interface ScheduleWithNames extends Schedule {
  agentName: string | null;
  projectName: string | null;
}

const columns = { schedule: schedules, agentName: agents.name, projectName: projects.name };
const withNames = (row: { schedule: Schedule; agentName: string | null; projectName: string | null }): ScheduleWithNames => ({
  ...row.schedule,
  agentName: row.agentName,
  projectName: row.projectName,
});

export async function listSchedulesForUser(db: Database, userId: string): Promise<ScheduleWithNames[]> {
  const rows = await db
    .select(columns)
    .from(schedules)
    .leftJoin(agents, eq(schedules.agentId, agents.id))
    .leftJoin(projects, eq(schedules.projectId, projects.id))
    .where(eq(schedules.userId, userId))
    .orderBy(asc(schedules.name));
  return rows.map(withNames);
}

export async function getScheduleForUser(db: Database, userId: string, id: string): Promise<ScheduleWithNames | null> {
  const [row] = await db
    .select(columns)
    .from(schedules)
    .leftJoin(agents, eq(schedules.agentId, agents.id))
    .leftJoin(projects, eq(schedules.projectId, projects.id))
    .where(and(eq(schedules.id, id), eq(schedules.userId, userId)))
    .limit(1);
  return row ? withNames(row) : null;
}

export async function createSchedule(db: Database, values: NewSchedule): Promise<Schedule> {
  const [row] = await db.insert(schedules).values(values).returning();
  if (!row) throw new Error("Failed to create schedule");
  return row;
}

export async function updateScheduleForUser(
  db: Database,
  userId: string,
  id: string,
  changes: Partial<Omit<NewSchedule, "id" | "userId" | "createdAt">>,
): Promise<Schedule | null> {
  const [row] = await db
    .update(schedules)
    .set(changes)
    .where(and(eq(schedules.id, id), eq(schedules.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteScheduleForUser(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.userId, userId)))
    .returning({ id: schedules.id });
  return rows.length > 0;
}

/** Enabled schedules whose next run is due. */
export async function listDueSchedules(db: Database, now: Date, limit = 20): Promise<Schedule[]> {
  return db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt), lte(schedules.nextRunAt, now)))
    .orderBy(asc(schedules.nextRunAt))
    .limit(limit);
}

/**
 * Moves a due schedule forward, but only if it is still due at the time we saw
 * it. The update returning a row is the claim: two tickers cannot both run it.
 */
export async function claimDueSchedule(db: Database, id: string, expectedNextRunAt: Date, followingRunAt: Date | null): Promise<Schedule | null> {
  const [row] = await db
    .update(schedules)
    .set({ nextRunAt: followingRunAt, lastRunAt: new Date(), runCount: sql`${schedules.runCount} + 1` })
    .where(and(eq(schedules.id, id), eq(schedules.nextRunAt, expectedNextRunAt)))
    .returning();
  return row ?? null;
}

export async function insertScheduleRun(db: Database, values: NewScheduleRun): Promise<ScheduleRun> {
  const [row] = await db.insert(scheduleRuns).values(values).returning();
  if (!row) throw new Error("Failed to record schedule run");
  return row;
}

export async function listScheduleRuns(db: Database, scheduleId: string, limit = 50): Promise<ScheduleRun[]> {
  return db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, scheduleId)).orderBy(desc(scheduleRuns.createdAt)).limit(limit);
}
