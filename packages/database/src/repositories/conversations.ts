import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { conversations, messages } from "../schema";

export type Conversation = typeof conversations.$inferSelect;

/** Escapes LIKE wildcards so user input is matched literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function createConversation(
  db: Database,
  input: { userId: string; title: string; projectId?: string | null },
): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({ userId: input.userId, title: input.title, projectId: input.projectId ?? null })
    .returning();
  if (!row) throw new Error("Failed to create conversation");
  return row;
}

export async function listConversations(
  db: Database,
  userId: string,
  options: { q?: string | undefined; archived: boolean; limit: number },
): Promise<Conversation[]> {
  const filters = [
    eq(conversations.userId, userId),
    options.archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
  ];

  if (options.q) {
    const pattern = likePattern(options.q);
    filters.push(
      or(
        ilike(conversations.title, pattern),
        sql`exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id} and ${messages.content} ilike ${pattern})`,
      )!,
    );
  }

  return db
    .select()
    .from(conversations)
    .where(and(...filters))
    .orderBy(desc(conversations.pinned), desc(conversations.lastMessageAt))
    .limit(options.limit);
}

/** Returns the conversation only if it belongs to `userId`. */
export async function getConversationForUser(
  db: Database,
  userId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function updateConversationForUser(
  db: Database,
  userId: string,
  conversationId: string,
  changes: { title?: string | undefined; pinned?: boolean | undefined; archived?: boolean | undefined },
): Promise<Conversation | null> {
  const values: Partial<typeof conversations.$inferInsert> = {};
  if (changes.title !== undefined) values.title = changes.title;
  if (changes.pinned !== undefined) values.pinned = changes.pinned;
  if (changes.archived !== undefined) values.archivedAt = changes.archived ? new Date() : null;

  const [row] = await db
    .update(conversations)
    .set(values)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteConversationForUser(
  db: Database,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

export async function touchConversation(db: Database, conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export async function listMessages(db: Database, conversationId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

export async function insertMessage(db: Database, values: NewMessage): Promise<Message> {
  const [row] = await db.insert(messages).values(values).returning();
  if (!row) throw new Error("Failed to insert message");
  return row;
}

export async function updateMessage(
  db: Database,
  messageId: string,
  values: Partial<Omit<NewMessage, "id" | "conversationId">>,
): Promise<void> {
  await db.update(messages).set(values).where(eq(messages.id, messageId));
}

export async function deleteMessage(db: Database, messageId: string): Promise<void> {
  await db.delete(messages).where(eq(messages.id, messageId));
}
