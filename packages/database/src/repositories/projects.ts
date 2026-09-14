import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../client";
import { conversations, memories, projects, tasks } from "../schema";

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export interface ProjectWithCounts extends Project {
  conversationCount: number;
  taskCount: number;
  memoryCount: number;
}

const counts = {
  conversationCount: sql<number>`(select count(*)::int from conversation where conversation.project_id = project.id)`.mapWith(Number),
  taskCount: sql<number>`(select count(*)::int from task where task.project_id = project.id)`.mapWith(Number),
  memoryCount: sql<number>`(select count(*)::int from memory where memory.project_id = project.id)`.mapWith(Number),
};

export async function listProjectsForUser(db: Database, userId: string, options: { archived?: boolean } = {}): Promise<ProjectWithCounts[]> {
  const rows = await db
    .select({ project: projects, ...counts })
    .from(projects)
    .where(and(eq(projects.ownerId, userId), options.archived ? undefined : isNull(projects.archivedAt)))
    .orderBy(desc(projects.updatedAt));
  return rows.map((r) => ({ ...r.project, conversationCount: r.conversationCount, taskCount: r.taskCount, memoryCount: r.memoryCount }));
}

export async function getProjectForUser(db: Database, userId: string, id: string): Promise<ProjectWithCounts | null> {
  const [row] = await db
    .select({ project: projects, ...counts })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
    .limit(1);
  return row ? { ...row.project, conversationCount: row.conversationCount, taskCount: row.taskCount, memoryCount: row.memoryCount } : null;
}

export async function createProject(db: Database, values: NewProject): Promise<Project> {
  const [row] = await db.insert(projects).values(values).returning();
  if (!row) throw new Error("Failed to create project");
  return row;
}

export async function updateProjectForUser(
  db: Database,
  userId: string,
  id: string,
  changes: Partial<Pick<NewProject, "name" | "description" | "archivedAt">>,
): Promise<Project | null> {
  const [row] = await db
    .update(projects)
    .set(changes)
    .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
    .returning();
  return row ?? null;
}

/** Deletes the project; its conversations and tasks survive with no project. */
export async function deleteProjectForUser(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(projects)
    .where(and(eq(projects.id, id), eq(projects.ownerId, userId)))
    .returning({ id: projects.id });
  return rows.length > 0;
}

export async function countProjectItems(db: Database, projectId: string): Promise<{ conversations: number; tasks: number; memories: number }> {
  const [conversationRow] = await db.select({ value: count() }).from(conversations).where(eq(conversations.projectId, projectId));
  const [taskRow] = await db.select({ value: count() }).from(tasks).where(eq(tasks.projectId, projectId));
  const [memoryRow] = await db.select({ value: count() }).from(memories).where(eq(memories.projectId, projectId));
  return { conversations: conversationRow?.value ?? 0, tasks: taskRow?.value ?? 0, memories: memoryRow?.value ?? 0 };
}
