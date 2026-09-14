import { and, asc, count, desc, eq, gte, inArray, ne, sql, sum } from "drizzle-orm";
import type { TaskError, TaskStatus } from "@aiw/shared";
import type { Database } from "../client";
import { agents, messages, projects, tasks, taskSteps, usageLogs } from "../schema";

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStep = typeof taskSteps.$inferSelect;
export type NewTaskStep = typeof taskSteps.$inferInsert;

export type TaskWithAgent = Task & { agent: Pick<typeof agents.$inferSelect, "id" | "name" | "slug"> | null; projectName: string | null };

const RUNNING_STATUSES: TaskStatus[] = ["queued", "planning", "running"];

export async function createTask(db: Database, values: NewTask): Promise<Task> {
  const [row] = await db.insert(tasks).values(values).returning();
  if (!row) throw new Error("Failed to create task");
  return row;
}

export async function getTask(db: Database, taskId: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
}

const taskWithAgentColumns = {
  task: tasks,
  agentId: agents.id,
  agentName: agents.name,
  agentSlug: agents.slug,
  projectName: projects.name,
};

function withAgent(row: { task: Task; agentId: string | null; agentName: string | null; agentSlug: string | null; projectName: string | null }): TaskWithAgent {
  return {
    ...row.task,
    agent: row.agentId && row.agentName && row.agentSlug ? { id: row.agentId, name: row.agentName, slug: row.agentSlug } : null,
    projectName: row.projectName,
  };
}

export async function getTaskForUser(db: Database, userId: string, taskId: string): Promise<TaskWithAgent | null> {
  const [row] = await db
    .select(taskWithAgentColumns)
    .from(tasks)
    .leftJoin(agents, eq(tasks.agentId, agents.id))
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  return row ? withAgent(row) : null;
}

export async function listTasksForUser(
  db: Database,
  userId: string,
  options: { statuses?: TaskStatus[] | undefined; limit: number },
): Promise<TaskWithAgent[]> {
  const filters = [eq(tasks.userId, userId)];
  if (options.statuses) filters.push(inArray(tasks.status, options.statuses));
  const rows = await db
    .select(taskWithAgentColumns)
    .from(tasks)
    .leftJoin(agents, eq(tasks.agentId, agents.id))
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(...filters))
    .orderBy(desc(tasks.createdAt))
    .limit(options.limit);
  return rows.map(withAgent);
}

export async function updateTask(
  db: Database,
  taskId: string,
  values: Partial<Omit<NewTask, "id" | "userId" | "createdAt">>,
): Promise<void> {
  await db.update(tasks).set(values).where(eq(tasks.id, taskId));
}

/**
 * Atomically moves a queued task into `planning`. Returns null if another
 * runner already claimed it or it is no longer queued.
 */
export async function claimQueuedTask(db: Database, taskId: string): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ status: "planning", startedAt: new Date(), completedAt: null, durationMs: null, error: null })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "queued")))
    .returning();
  return row ?? null;
}

/** Adds token usage and cost to a task's running totals atomically. */
export async function addTaskUsage(
  db: Database,
  taskId: string,
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null },
): Promise<void> {
  await db
    .update(tasks)
    .set({
      inputTokens: sql`${tasks.inputTokens} + ${usage.inputTokens}`,
      outputTokens: sql`${tasks.outputTokens} + ${usage.outputTokens}`,
      ...(usage.costUsd !== null
        ? { estimatedCostUsd: sql`coalesce(${tasks.estimatedCostUsd}, 0) + ${usage.costUsd}` }
        : {}),
    })
    .where(eq(tasks.id, taskId));
}

export async function countRunningTasksForUser(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, RUNNING_STATUSES)));
  return row?.value ?? 0;
}

/** Running and paused task counts per agent for a user. */
export async function countActiveTasksByAgent(
  db: Database,
  userId: string,
): Promise<Map<string, { running: number; paused: number }>> {
  const rows = await db
    .select({ agentId: tasks.agentId, status: tasks.status, value: count() })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...RUNNING_STATUSES, "paused"])))
    .groupBy(tasks.agentId, tasks.status);
  const result = new Map<string, { running: number; paused: number }>();
  for (const row of rows) {
    if (!row.agentId) continue;
    const entry = result.get(row.agentId) ?? { running: 0, paused: 0 };
    if (row.status === "paused") entry.paused += row.value;
    else entry.running += row.value;
    result.set(row.agentId, entry);
  }
  return result;
}

export async function listTaskSteps(db: Database, taskId: string): Promise<TaskStep[]> {
  return db.select().from(taskSteps).where(eq(taskSteps.taskId, taskId)).orderBy(asc(taskSteps.index));
}

export async function listTaskStepsForTasks(db: Database, taskIds: string[]): Promise<TaskStep[]> {
  if (taskIds.length === 0) return [];
  return db.select().from(taskSteps).where(inArray(taskSteps.taskId, taskIds)).orderBy(asc(taskSteps.index));
}

export async function insertTaskSteps(db: Database, values: NewTaskStep[]): Promise<TaskStep[]> {
  if (values.length === 0) return [];
  return db.insert(taskSteps).values(values).returning();
}

export async function updateTaskStep(
  db: Database,
  stepId: string,
  values: Partial<Omit<NewTaskStep, "id" | "taskId" | "index">>,
): Promise<void> {
  await db.update(taskSteps).set(values).where(eq(taskSteps.id, stepId));
}

/** Records a pause request for a task that is still executing. Returns false if it is not. */
export async function requestTaskPause(db: Database, taskId: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ pauseRequestedAt: new Date() })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, RUNNING_STATUSES)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export async function isTaskPauseRequested(db: Database, taskId: string): Promise<boolean> {
  const [row] = await db.select({ at: tasks.pauseRequestedAt }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return Boolean(row?.at);
}

/** Resets every unfinished step so execution can continue from the first one. */
/**
 * Puts unfinished steps back to pending for a continue. The step's `error` is
 * deliberately kept: it is what the agent is told when it tries again (spec §40).
 */
export async function resetUnfinishedSteps(db: Database, taskId: string): Promise<void> {
  await db
    .update(taskSteps)
    .set({ status: "pending", output: null, startedAt: null, completedAt: null, durationMs: null })
    .where(and(eq(taskSteps.taskId, taskId), ne(taskSteps.status, "completed")));
}

/** Total estimated cost recorded for an agent since `since`. */
export async function sumAgentCostSince(db: Database, agentId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ value: sum(usageLogs.estimatedCostUsd) })
    .from(usageLogs)
    .where(and(eq(usageLogs.agentId, agentId), gte(usageLogs.createdAt, since)));
  return Number(row?.value ?? 0);
}

export async function getMessageForTask(db: Database, taskId: string) {
  const [row] = await db.select().from(messages).where(eq(messages.taskId, taskId)).limit(1);
  return row ?? null;
}

export async function updateMessagesForTask(
  db: Database,
  taskId: string,
  values: Partial<Pick<typeof messages.$inferInsert, "content" | "status" | "error" | "provider" | "model" | "inputTokens" | "outputTokens" | "completedAt" | "taskId" | "finishReason">>,
): Promise<void> {
  await db.update(messages).set(values).where(eq(messages.taskId, taskId));
}

/**
 * Marks tasks left in a running state by a previous server process as failed
 * so they can be continued. Returns the affected tasks.
 */
export async function failInterruptedTasks(
  db: Database,
  error: TaskError,
): Promise<{ id: string; userId: string; agentId: string | null }[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({ status: "failed", error, completedAt: new Date(), pauseRequestedAt: null })
      .where(inArray(tasks.status, RUNNING_STATUSES))
      .returning({ id: tasks.id, userId: tasks.userId, agentId: tasks.agentId });
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await tx
        .update(taskSteps)
        .set({ status: "failed", error: error.message, completedAt: new Date() })
        .where(and(inArray(taskSteps.taskId, ids), eq(taskSteps.status, "running")));
      await tx
        .update(messages)
        .set({ status: "failed", error: error.title, completedAt: new Date() })
        .where(and(inArray(messages.taskId, ids), eq(messages.status, "streaming")));
    }
    return rows;
  });
}

/** Tasks another agent delegated from this one (spec §28). */
export async function listSubTasks(db: Database, parentTaskId: string): Promise<TaskWithAgent[]> {
  const rows = await db
    .select(taskWithAgentColumns)
    .from(tasks)
    .leftJoin(agents, eq(tasks.agentId, agents.id))
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(asc(tasks.createdAt));
  return rows.map(withAgent);
}
