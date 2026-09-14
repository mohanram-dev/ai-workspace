import { and, asc, desc, eq, gt, max } from "drizzle-orm";
import type { Database } from "../client";
import { taskEvents } from "../schema";

export type TaskEventRow = typeof taskEvents.$inferSelect;
export type NewTaskEventRow = typeof taskEvents.$inferInsert;

export async function insertTaskEvent(db: Database, values: NewTaskEventRow): Promise<TaskEventRow> {
  const [row] = await db.insert(taskEvents).values(values).returning();
  if (!row) throw new Error("Failed to insert task event");
  return row;
}

/** Events for a task in order, optionally only those after an id (stream resume). */
export async function listTaskEvents(
  db: Database,
  taskId: string,
  options: { afterId?: number; limit?: number } = {},
): Promise<TaskEventRow[]> {
  return db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), options.afterId ? gt(taskEvents.id, options.afterId) : undefined))
    .orderBy(asc(taskEvents.id))
    .limit(options.limit ?? 1000);
}

/** The most recent events for a task, returned oldest first. */
export async function listRecentTaskEvents(db: Database, taskId: string, limit: number): Promise<TaskEventRow[]> {
  const rows = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.id))
    .limit(limit);
  return rows.reverse();
}

export async function getLastTaskEventId(db: Database, taskId: string): Promise<number> {
  const [row] = await db.select({ value: max(taskEvents.id) }).from(taskEvents).where(eq(taskEvents.taskId, taskId));
  return row?.value ?? 0;
}
