import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createConversation,
  createDatabase,
  deleteConversationForUser,
  getConversationForUser,
  insertMessage,
  listConversations,
  listMessages,
  updateConversationForUser,
  type DatabaseHandle,
} from "../src";
import { messages, users } from "../src/schema";
import { getTestDatabaseUrl } from "../src/testing";
import { eq } from "drizzle-orm";

let handle: DatabaseHandle;

async function createUser(): Promise<string> {
  const id = randomUUID();
  await handle.db.insert(users).values({ id, name: "Test", email: `${id}@example.test` });
  return id;
}

beforeAll(() => {
  handle = createDatabase(getTestDatabaseUrl(), { max: 2 });
});

afterAll(async () => {
  await handle.close();
});

describe("conversation repository", () => {
  it("scopes reads, updates and deletes to the owning user", async () => {
    const owner = await createUser();
    const other = await createUser();
    const conversation = await createConversation(handle.db, { userId: owner, title: "Mine" });

    expect(await getConversationForUser(handle.db, other, conversation.id)).toBeNull();
    expect(
      await updateConversationForUser(handle.db, other, conversation.id, { title: "Hijacked" }),
    ).toBeNull();
    expect(await deleteConversationForUser(handle.db, other, conversation.id)).toBe(false);

    const fetched = await getConversationForUser(handle.db, owner, conversation.id);
    expect(fetched?.title).toBe("Mine");
    expect(await listConversations(handle.db, other, { archived: false, limit: 50 })).toEqual([]);
  });

  it("orders pinned conversations first and separates archived ones", async () => {
    const userId = await createUser();
    const a = await createConversation(handle.db, { userId, title: "A" });
    const b = await createConversation(handle.db, { userId, title: "B" });
    const c = await createConversation(handle.db, { userId, title: "C" });

    await updateConversationForUser(handle.db, userId, a.id, { pinned: true });
    await updateConversationForUser(handle.db, userId, c.id, { archived: true });

    const active = await listConversations(handle.db, userId, { archived: false, limit: 50 });
    expect(active.map((row) => row.title)).toEqual(["A", "B"]);
    expect(active.some((row) => row.id === b.id)).toBe(true);

    const archived = await listConversations(handle.db, userId, { archived: true, limit: 50 });
    expect(archived.map((row) => row.title)).toEqual(["C"]);

    await updateConversationForUser(handle.db, userId, c.id, { archived: false });
    const restored = await listConversations(handle.db, userId, { archived: false, limit: 50 });
    expect(restored).toHaveLength(3);
  });

  it("searches titles and message content, treating wildcards literally", async () => {
    const userId = await createUser();
    const titled = await createConversation(handle.db, { userId, title: "Docker disk usage" });
    const bodied = await createConversation(handle.db, { userId, title: "Untitled" });
    await insertMessage(handle.db, {
      conversationId: bodied.id,
      role: "user",
      content: "Why is postgres at 100% CPU?",
    });

    const byTitle = await listConversations(handle.db, userId, {
      q: "docker",
      archived: false,
      limit: 50,
    });
    expect(byTitle.map((row) => row.id)).toEqual([titled.id]);

    const byContent = await listConversations(handle.db, userId, {
      q: "100%",
      archived: false,
      limit: 50,
    });
    expect(byContent.map((row) => row.id)).toEqual([bodied.id]);

    const wildcard = await listConversations(handle.db, userId, {
      q: "%",
      archived: false,
      limit: 50,
    });
    expect(wildcard.map((row) => row.id)).toEqual([bodied.id]);
  });

  it("returns messages in insertion order and cascades on delete", async () => {
    const userId = await createUser();
    const conversation = await createConversation(handle.db, { userId, title: "Chat" });
    for (const [role, content] of [
      ["user", "one"],
      ["assistant", "two"],
      ["user", "three"],
    ] as const) {
      await insertMessage(handle.db, { conversationId: conversation.id, role, content });
    }

    const rows = await listMessages(handle.db, conversation.id);
    expect(rows.map((row) => row.content)).toEqual(["one", "two", "three"]);

    expect(await deleteConversationForUser(handle.db, userId, conversation.id)).toBe(true);
    const orphaned = await handle.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(orphaned).toEqual([]);
  });
});
