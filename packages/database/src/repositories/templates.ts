import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agents, projects, promptTemplates } from "../schema";

export type PromptTemplate = typeof promptTemplates.$inferSelect;
export type NewPromptTemplate = typeof promptTemplates.$inferInsert;

export interface PromptTemplateWithNames extends PromptTemplate {
  agentName: string | null;
  projectName: string | null;
}

const columns = { template: promptTemplates, agentName: agents.name, projectName: projects.name };
const withNames = (row: { template: PromptTemplate; agentName: string | null; projectName: string | null }): PromptTemplateWithNames => ({
  ...row.template,
  agentName: row.agentName,
  projectName: row.projectName,
});

/** Recently used first, then by name, so the menu opens on what you reach for. */
export async function listTemplatesForUser(db: Database, userId: string): Promise<PromptTemplateWithNames[]> {
  const rows = await db
    .select(columns)
    .from(promptTemplates)
    .leftJoin(agents, eq(promptTemplates.agentId, agents.id))
    .leftJoin(projects, eq(promptTemplates.projectId, projects.id))
    .where(eq(promptTemplates.userId, userId))
    .orderBy(sql`${promptTemplates.lastUsedAt} desc nulls last`, asc(promptTemplates.name));
  return rows.map(withNames);
}

export async function getTemplateForUser(db: Database, userId: string, id: string): Promise<PromptTemplateWithNames | null> {
  const [row] = await db
    .select(columns)
    .from(promptTemplates)
    .leftJoin(agents, eq(promptTemplates.agentId, agents.id))
    .leftJoin(projects, eq(promptTemplates.projectId, projects.id))
    .where(and(eq(promptTemplates.id, id), eq(promptTemplates.userId, userId)))
    .limit(1);
  return row ? withNames(row) : null;
}

export async function countTemplatesForUser(db: Database, userId: string): Promise<number> {
  const [row] = await db.select({ value: count() }).from(promptTemplates).where(eq(promptTemplates.userId, userId));
  return row?.value ?? 0;
}

export async function createTemplate(db: Database, values: NewPromptTemplate): Promise<PromptTemplate> {
  const [row] = await db.insert(promptTemplates).values(values).returning();
  return row!;
}

export async function updateTemplateForUser(
  db: Database,
  userId: string,
  id: string,
  changes: Partial<Omit<NewPromptTemplate, "id" | "userId" | "createdAt">>,
): Promise<PromptTemplate | null> {
  const [row] = await db
    .update(promptTemplates)
    .set(changes)
    .where(and(eq(promptTemplates.id, id), eq(promptTemplates.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteTemplateForUser(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(promptTemplates)
    .where(and(eq(promptTemplates.id, id), eq(promptTemplates.userId, userId)))
    .returning({ id: promptTemplates.id });
  return rows.length > 0;
}

/** Marks a template used, which moves it to the top of the menu. */
export async function markTemplateUsed(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(promptTemplates)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(promptTemplates.id, id), eq(promptTemplates.userId, userId)))
    .returning({ id: promptTemplates.id });
  return rows.length > 0;
}
