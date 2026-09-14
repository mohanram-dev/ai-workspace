import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { agents } from "../schema";

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

export async function listAgentsForUser(db: Database, userId: string): Promise<Agent[]> {
  return db
    .select()
    .from(agents)
    .where(eq(agents.ownerId, userId))
    .orderBy(desc(agents.builtin), asc(agents.createdAt), asc(agents.name));
}

export async function getAgentForUser(db: Database, userId: string, agentId: string): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .limit(1);
  return row ?? null;
}

/** Inserts agents, skipping any whose (owner, slug) already exists. */
export async function insertAgentsIfMissing(db: Database, values: NewAgent[]): Promise<void> {
  if (values.length === 0) return;
  await db.insert(agents).values(values).onConflictDoNothing({ target: [agents.ownerId, agents.slug] });
}

export async function createAgent(db: Database, values: NewAgent): Promise<Agent> {
  const [row] = await db.insert(agents).values(values).returning();
  if (!row) throw new Error("Failed to create agent");
  return row;
}

export async function updateAgentForUser(
  db: Database,
  userId: string,
  agentId: string,
  changes: Partial<Omit<NewAgent, "id" | "ownerId" | "slug" | "builtin" | "createdAt">>,
): Promise<Agent | null> {
  const [row] = await db
    .update(agents)
    .set(changes)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteAgentForUser(db: Database, userId: string, agentId: string): Promise<boolean> {
  const rows = await db
    .delete(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, userId), eq(agents.builtin, false)))
    .returning({ id: agents.id });
  return rows.length > 0;
}
