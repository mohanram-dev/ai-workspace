import { asc, count, eq } from "drizzle-orm";
import type { Database } from "../client";
import { toolCalls } from "../schema";

export type ToolCall = typeof toolCalls.$inferSelect;
export type NewToolCall = typeof toolCalls.$inferInsert;

export async function insertToolCall(db: Database, values: NewToolCall): Promise<ToolCall> {
  const [row] = await db.insert(toolCalls).values(values).returning();
  if (!row) throw new Error("Failed to insert tool call");
  return row;
}

export async function updateToolCall(
  db: Database,
  id: string,
  values: Partial<Omit<NewToolCall, "id" | "taskId" | "userId" | "createdAt">>,
): Promise<void> {
  await db.update(toolCalls).set(values).where(eq(toolCalls.id, id));
}

export async function countToolCallsForTask(db: Database, taskId: string): Promise<number> {
  const [row] = await db.select({ value: count() }).from(toolCalls).where(eq(toolCalls.taskId, taskId));
  return row?.value ?? 0;
}

export async function listToolCallsForTask(db: Database, taskId: string, limit = 500): Promise<ToolCall[]> {
  return db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId)).orderBy(asc(toolCalls.createdAt)).limit(limit);
}
