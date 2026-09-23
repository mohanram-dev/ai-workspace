import { and, asc, count, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agents, apiTokens, projects, webhooks } from "../schema";

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;

export interface WebhookWithNames extends Webhook {
  agentName: string | null;
  projectName: string | null;
}

// --- API tokens -------------------------------------------------------------

export async function createApiToken(db: Database, values: NewApiToken): Promise<ApiToken> {
  const [row] = await db.insert(apiTokens).values(values).returning();
  return row!;
}

export async function listApiTokensForUser(db: Database, userId: string): Promise<ApiToken[]> {
  return db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(desc(apiTokens.createdAt));
}

export async function countApiTokensForUser(db: Database, userId: string): Promise<number> {
  const [row] = await db.select({ value: count() }).from(apiTokens).where(eq(apiTokens.userId, userId));
  return row?.value ?? 0;
}

export async function deleteApiTokenForUser(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db.delete(apiTokens).where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId))).returning({ id: apiTokens.id });
  return rows.length > 0;
}

/** The token whose SHA-256 this is. The caller hashes; the plain token never reaches the database. */
export async function findApiTokenByHash(db: Database, tokenHash: string): Promise<ApiToken | null> {
  const [row] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

/** Records a use, at most once a minute, so a busy integration does not write on every request. */
export async function touchApiToken(db: Database, id: string, now = new Date()): Promise<void> {
  await db
    .update(apiTokens)
    .set({ lastUsedAt: now })
    // Typed operators, not a raw sql fragment: they encode the Date for the driver.
    .where(and(eq(apiTokens.id, id), or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, new Date(now.getTime() - 60_000)))));
}

// --- Webhooks ---------------------------------------------------------------

const webhookColumns = { webhook: webhooks, agentName: agents.name, projectName: projects.name };
const withNames = (row: { webhook: Webhook; agentName: string | null; projectName: string | null }): WebhookWithNames => ({
  ...row.webhook,
  agentName: row.agentName,
  projectName: row.projectName,
});

export async function createWebhook(db: Database, values: NewWebhook): Promise<Webhook> {
  const [row] = await db.insert(webhooks).values(values).returning();
  return row!;
}

export async function listWebhooksForUser(db: Database, userId: string): Promise<WebhookWithNames[]> {
  const rows = await db
    .select(webhookColumns)
    .from(webhooks)
    .leftJoin(agents, eq(webhooks.agentId, agents.id))
    .leftJoin(projects, eq(webhooks.projectId, projects.id))
    .where(eq(webhooks.userId, userId))
    .orderBy(asc(webhooks.name));
  return rows.map(withNames);
}

export async function getWebhookForUser(db: Database, userId: string, id: string): Promise<WebhookWithNames | null> {
  const [row] = await db
    .select(webhookColumns)
    .from(webhooks)
    .leftJoin(agents, eq(webhooks.agentId, agents.id))
    .leftJoin(projects, eq(webhooks.projectId, projects.id))
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .limit(1);
  return row ? withNames(row) : null;
}

/** For the public endpoint, which has no session: the secret check is what authorises the call. */
export async function getWebhook(db: Database, id: string): Promise<Webhook | null> {
  const [row] = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
  return row ?? null;
}

export async function countWebhooksForUser(db: Database, userId: string): Promise<number> {
  const [row] = await db.select({ value: count() }).from(webhooks).where(eq(webhooks.userId, userId));
  return row?.value ?? 0;
}

export async function updateWebhookForUser(
  db: Database,
  userId: string,
  id: string,
  changes: Partial<Omit<NewWebhook, "id" | "userId" | "createdAt">>,
): Promise<Webhook | null> {
  const [row] = await db
    .update(webhooks)
    .set(changes)
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteWebhookForUser(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db.delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.userId, userId))).returning({ id: webhooks.id });
  return rows.length > 0;
}

/** Counts a delivery that started a task, and remembers where it went. */
export async function recordWebhookTrigger(db: Database, id: string, values: { taskId: string; conversationId: string }): Promise<void> {
  await db
    .update(webhooks)
    .set({
      lastTaskId: values.taskId,
      conversationId: values.conversationId,
      lastTriggeredAt: new Date(),
      triggerCount: sql`${webhooks.triggerCount} + 1`,
    })
    .where(eq(webhooks.id, id));
}
