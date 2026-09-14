import { and, asc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { Database } from "../client";
import { memories } from "../schema";

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type MemoryScope = Memory["scope"];

export interface MemoryTarget {
  scope: MemoryScope;
  projectId?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
}

function scopeFilter(userId: string, target: MemoryTarget): SQL | undefined {
  const owner = eq(memories.userId, userId);
  if (target.scope === "project") return and(owner, eq(memories.scope, "project"), eq(memories.projectId, target.projectId!));
  if (target.scope === "agent") return and(owner, eq(memories.scope, "agent"), eq(memories.agentId, target.agentId!));
  return and(owner, eq(memories.scope, "conversation"), eq(memories.conversationId, target.conversationId!));
}

/** Writes a fact, replacing any existing value for the same key in that scope. */
export async function rememberMemory(
  db: Database,
  values: { userId: string; key: string; value: string; source?: "user" | "agent"; taskId?: string | null } & MemoryTarget,
): Promise<Memory> {
  const existing = await db
    .select()
    .from(memories)
    .where(and(scopeFilter(values.userId, values), eq(memories.key, values.key)))
    .limit(1);
  if (existing[0]) {
    const [row] = await db
      .update(memories)
      .set({ value: values.value, source: values.source ?? "user", taskId: values.taskId ?? null })
      .where(eq(memories.id, existing[0].id))
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(memories)
    .values({
      userId: values.userId,
      scope: values.scope,
      projectId: values.projectId ?? null,
      agentId: values.agentId ?? null,
      conversationId: values.conversationId ?? null,
      key: values.key,
      value: values.value,
      source: values.source ?? "user",
      taskId: values.taskId ?? null,
    })
    .returning();
  if (!row) throw new Error("Failed to store memory");
  return row;
}

export async function listMemories(db: Database, userId: string, target: MemoryTarget, limit = 200): Promise<Memory[]> {
  return db.select().from(memories).where(scopeFilter(userId, target)).orderBy(asc(memories.key)).limit(limit);
}

/** Everything an agent should know for a task: its own memory plus the project's. */
export async function listMemoriesForTask(
  db: Database,
  userId: string,
  context: { agentId: string | null; projectId: string | null; conversationId: string | null },
  limit = 100,
): Promise<Memory[]> {
  const scopes: SQL[] = [];
  if (context.agentId) scopes.push(and(eq(memories.scope, "agent"), eq(memories.agentId, context.agentId))!);
  if (context.projectId) scopes.push(and(eq(memories.scope, "project"), eq(memories.projectId, context.projectId))!);
  if (context.conversationId) scopes.push(and(eq(memories.scope, "conversation"), eq(memories.conversationId, context.conversationId))!);
  if (scopes.length === 0) return [];
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId), or(...scopes)))
    .orderBy(asc(memories.scope), asc(memories.key))
    .limit(limit);
}

export async function listMemoriesForUser(db: Database, userId: string, limit = 500): Promise<Memory[]> {
  return db.select().from(memories).where(eq(memories.userId, userId)).orderBy(asc(memories.scope), asc(memories.key)).limit(limit);
}

export async function getMemoryForUser(db: Database, userId: string, id: string): Promise<Memory | null> {
  const [row] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.id, id), eq(memories.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function updateMemoryForUser(db: Database, userId: string, id: string, changes: { key?: string; value?: string }): Promise<Memory | null> {
  const [row] = await db
    .update(memories)
    .set(changes)
    .where(and(eq(memories.id, id), eq(memories.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteMemoryForUser(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(memories)
    .where(and(eq(memories.id, id), eq(memories.userId, userId)))
    .returning({ id: memories.id });
  return rows.length > 0;
}

/** Deletes by key within a scope; used by the agent's forget tool. */
export async function forgetMemory(db: Database, userId: string, target: MemoryTarget, key: string): Promise<boolean> {
  const rows = await db
    .delete(memories)
    .where(and(scopeFilter(userId, target), eq(memories.key, key)))
    .returning({ id: memories.id });
  return rows.length > 0;
}

/** Memories that belong to no project, for the "personal" view. */
export async function listUnscopedMemories(db: Database, userId: string): Promise<Memory[]> {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId), isNull(memories.projectId)))
    .orderBy(asc(memories.key));
}

export async function deleteMemoriesByIds(db: Database, userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .delete(memories)
    .where(and(eq(memories.userId, userId), inArray(memories.id, ids)))
    .returning({ id: memories.id });
  return rows.length;
}
