import { and, avg, count, desc, eq, gte, inArray, isNotNull, ne, sql, sum } from "drizzle-orm";
import type { TaskStatus } from "@aiw/shared";
import type { Database } from "../client";
import { agents, taskEvents, tasks, toolCalls, usageLogs } from "../schema";

/**
 * Aggregates behind the Activity dashboard. Everything here is read from rows
 * the runtime already writes (tasks, tool_call, usage_log, task_event); nothing
 * is sampled or estimated beyond the cost figures the providers' pricing gives.
 */

export interface ActivityTotals {
  tasks: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  /** Completed ÷ finished tasks, or null when nothing has finished yet. */
  successRate: number | null;
  avgDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  toolCalls: number;
  failedToolCalls: number;
  activeAgents: number;
}

export interface AgentActivityRow {
  agentId: string;
  agentName: string;
  agentSlug: string;
  tasks: number;
  completed: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  avgDurationMs: number | null;
}

export interface ModelUsageRow {
  provider: string;
  model: string;
  purpose: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ToolUsageRow {
  toolName: string;
  category: string | null;
  calls: number;
  failed: number;
  denied: number;
  avgDurationMs: number | null;
}

export interface ErrorRow {
  title: string;
  count: number;
  lastAt: Date;
}

const RUNNING_STATUSES: TaskStatus[] = ["queued", "planning", "running", "waiting_for_approval", "paused"];

export async function getActivityTotals(db: Database, userId: string, since: Date): Promise<ActivityTotals> {
  const window = and(eq(tasks.userId, userId), gte(tasks.createdAt, since));

  const [taskRow] = await db
    .select({
      tasks: count(),
      completed: sql<number>`count(*) filter (where ${tasks.status} = 'completed')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')`.mapWith(Number),
      cancelled: sql<number>`count(*) filter (where ${tasks.status} = 'cancelled')`.mapWith(Number),
      inputTokens: sql<number>`coalesce(sum(${tasks.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${tasks.outputTokens}), 0)`.mapWith(Number),
      estimatedCostUsd: sql<number>`coalesce(sum(${tasks.estimatedCostUsd}), 0)`.mapWith(Number),
      // Only finished runs have a duration, so the average ignores the rest.
      avgDurationMs: avg(tasks.durationMs).mapWith(Number),
      activeAgents: sql<number>`count(distinct ${tasks.agentId})`.mapWith(Number),
    })
    .from(tasks)
    .where(window);

  // Running tasks are "right now", not "in the window": a task started before
  // the window that is still going is still occupying the machine.
  const [runningRow] = await db
    .select({ running: count() })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, RUNNING_STATUSES)));

  const [toolRow] = await db
    .select({
      calls: count(),
      failed: sql<number>`count(*) filter (where ${toolCalls.status} in ('failed', 'denied'))`.mapWith(Number),
    })
    .from(toolCalls)
    .innerJoin(tasks, eq(toolCalls.taskId, tasks.id))
    .where(and(eq(tasks.userId, userId), gte(toolCalls.createdAt, since)));

  const finished = (taskRow?.completed ?? 0) + (taskRow?.failed ?? 0) + (taskRow?.cancelled ?? 0);
  return {
    tasks: taskRow?.tasks ?? 0,
    completed: taskRow?.completed ?? 0,
    failed: taskRow?.failed ?? 0,
    cancelled: taskRow?.cancelled ?? 0,
    running: runningRow?.running ?? 0,
    successRate: finished > 0 ? (taskRow?.completed ?? 0) / finished : null,
    avgDurationMs: taskRow?.avgDurationMs ?? null,
    inputTokens: taskRow?.inputTokens ?? 0,
    outputTokens: taskRow?.outputTokens ?? 0,
    estimatedCostUsd: taskRow?.estimatedCostUsd ?? 0,
    toolCalls: toolRow?.calls ?? 0,
    failedToolCalls: toolRow?.failed ?? 0,
    activeAgents: taskRow?.activeAgents ?? 0,
  };
}

export async function listAgentActivity(db: Database, userId: string, since: Date): Promise<AgentActivityRow[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      agentSlug: agents.slug,
      tasks: count(),
      completed: sql<number>`count(*) filter (where ${tasks.status} = 'completed')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')`.mapWith(Number),
      inputTokens: sql<number>`coalesce(sum(${tasks.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${tasks.outputTokens}), 0)`.mapWith(Number),
      estimatedCostUsd: sql<number>`coalesce(sum(${tasks.estimatedCostUsd}), 0)`.mapWith(Number),
      avgDurationMs: avg(tasks.durationMs).mapWith(Number),
    })
    .from(tasks)
    .innerJoin(agents, eq(tasks.agentId, agents.id))
    .where(and(eq(tasks.userId, userId), gte(tasks.createdAt, since)))
    .groupBy(agents.id, agents.name, agents.slug)
    .orderBy(desc(count()));
  return rows.map((r) => ({ ...r, avgDurationMs: r.avgDurationMs ?? null }));
}

export async function listModelUsage(db: Database, userId: string, since: Date): Promise<ModelUsageRow[]> {
  return db
    .select({
      provider: usageLogs.provider,
      model: usageLogs.model,
      purpose: usageLogs.purpose,
      calls: count(),
      inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}), 0)`.mapWith(Number),
      estimatedCostUsd: sql<number>`coalesce(sum(${usageLogs.estimatedCostUsd}), 0)`.mapWith(Number),
    })
    .from(usageLogs)
    .where(and(eq(usageLogs.userId, userId), gte(usageLogs.createdAt, since)))
    .groupBy(usageLogs.provider, usageLogs.model, usageLogs.purpose)
    .orderBy(desc(sql`coalesce(sum(${usageLogs.estimatedCostUsd}), 0)`));
}

export async function listToolUsage(db: Database, userId: string, since: Date): Promise<ToolUsageRow[]> {
  const rows = await db
    .select({
      toolName: toolCalls.toolName,
      category: toolCalls.category,
      calls: count(),
      failed: sql<number>`count(*) filter (where ${toolCalls.status} = 'failed')`.mapWith(Number),
      denied: sql<number>`count(*) filter (where ${toolCalls.status} = 'denied')`.mapWith(Number),
      avgDurationMs: avg(toolCalls.durationMs).mapWith(Number),
    })
    .from(toolCalls)
    .innerJoin(tasks, eq(toolCalls.taskId, tasks.id))
    .where(and(eq(tasks.userId, userId), gte(toolCalls.createdAt, since)))
    .groupBy(toolCalls.toolName, toolCalls.category)
    .orderBy(desc(count()));
  return rows.map((r) => ({ ...r, avgDurationMs: r.avgDurationMs ?? null }));
}

/** Failed tasks grouped by the error title the runtime recorded. */
export async function listErrorBreakdown(db: Database, userId: string, since: Date): Promise<ErrorRow[]> {
  const title = sql<string>`coalesce(${tasks.error} ->> 'title', 'Unknown error')`;
  return db
    .select({ title, count: count(), lastAt: sql<Date>`max(${tasks.createdAt})` })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), gte(tasks.createdAt, since), eq(tasks.status, "failed"), isNotNull(tasks.error)))
    .groupBy(title)
    .orderBy(desc(count()));
}

/** Tasks started per day in the window, for the trend chart. */
export async function listDailyTaskCounts(db: Database, userId: string, since: Date): Promise<{ day: string; total: number; completed: number; failed: number }[]> {
  const day = sql<string>`to_char(date_trunc('day', ${tasks.createdAt}), 'YYYY-MM-DD')`;
  return db
    .select({
      day,
      total: count(),
      completed: sql<number>`count(*) filter (where ${tasks.status} = 'completed')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')`.mapWith(Number),
    })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), gte(tasks.createdAt, since)))
    .groupBy(day)
    .orderBy(day);
}

/** The newest events across all of the user's tasks, seeding the live feed. */
export async function listRecentActivityEvents(db: Database, userId: string, limit: number) {
  return db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.userId, userId), ne(taskEvents.type, "THINKING_STATUS")))
    .orderBy(desc(taskEvents.id))
    .limit(limit);
}

/** Total spend since a date, used for the "all time" figure next to the window. */
export async function sumUserCostSince(db: Database, userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ value: sum(usageLogs.estimatedCostUsd) })
    .from(usageLogs)
    .where(and(eq(usageLogs.userId, userId), gte(usageLogs.createdAt, since)));
  return Number(row?.value ?? 0);
}
