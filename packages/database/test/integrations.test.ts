import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countApiTokensForUser,
  createApiToken,
  createConversation,
  createDatabase,
  createTask,
  createWebhook,
  deleteApiTokenForUser,
  deleteWebhookForUser,
  findApiTokenByHash,
  getWebhook,
  getWebhookForUser,
  listApiTokensForUser,
  listWebhooksForUser,
  recordWebhookTrigger,
  touchApiToken,
  updateWebhookForUser,
  type DatabaseHandle,
} from "../src";
import { users } from "../src/schema";
import { getTestDatabaseUrl } from "../src/testing";

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

describe("API token repository", () => {
  it("finds a token only by its hash, and scopes listing and deleting to the owner", async () => {
    const owner = await createUser();
    const other = await createUser();
    const hash = randomUUID().replace(/-/g, "").repeat(2);
    const token = await createApiToken(handle.db, { userId: owner, name: "n8n", tokenHash: hash, prefix: "aiw_abcdefgh" });

    expect((await findApiTokenByHash(handle.db, hash))?.id).toBe(token.id);
    expect(await findApiTokenByHash(handle.db, "0".repeat(64))).toBeNull();
    expect(await listApiTokensForUser(handle.db, other)).toEqual([]);
    expect(await deleteApiTokenForUser(handle.db, other, token.id)).toBe(false);
    expect(await countApiTokensForUser(handle.db, owner)).toBe(1);
    expect(await deleteApiTokenForUser(handle.db, owner, token.id)).toBe(true);
    // A revoked token stops working at once.
    expect(await findApiTokenByHash(handle.db, hash)).toBeNull();
  });

  it("records a use at most once a minute", async () => {
    const userId = await createUser();
    const token = await createApiToken(handle.db, { userId, name: "script", tokenHash: randomUUID() + randomUUID(), prefix: "aiw_12345678" });
    const first = new Date("2026-09-23T10:00:00Z");
    await touchApiToken(handle.db, token.id, first);
    await touchApiToken(handle.db, token.id, new Date("2026-09-23T10:00:30Z"));
    expect((await listApiTokensForUser(handle.db, userId))[0]?.lastUsedAt).toEqual(first);
    const later = new Date("2026-09-23T10:02:00Z");
    await touchApiToken(handle.db, token.id, later);
    expect((await listApiTokensForUser(handle.db, userId))[0]?.lastUsedAt).toEqual(later);
  });
});

describe("webhook repository", () => {
  it("scopes management to the owner but lets the public endpoint look a webhook up by id", async () => {
    const owner = await createUser();
    const other = await createUser();
    const webhook = await createWebhook(handle.db, { userId: owner, name: "GitHub issues", prompt: "Triage it", secretEncrypted: "v1:x:y:z" });

    expect(await getWebhookForUser(handle.db, other, webhook.id)).toBeNull();
    expect(await updateWebhookForUser(handle.db, other, webhook.id, { enabled: false })).toBeNull();
    expect(await deleteWebhookForUser(handle.db, other, webhook.id)).toBe(false);
    expect(await listWebhooksForUser(handle.db, other)).toEqual([]);
    expect((await getWebhook(handle.db, webhook.id))?.userId).toBe(owner);
  });

  it("counts deliveries and remembers the conversation they went to", async () => {
    const userId = await createUser();
    const webhook = await createWebhook(handle.db, { userId, name: "Deploys", prompt: "Check it", secretEncrypted: "v1:x:y:z" });
    const conversation = await createConversation(handle.db, { userId, title: "Deploys" });
    const task = await createTask(handle.db, { userId, conversationId: conversation.id, prompt: "Check it" });

    await recordWebhookTrigger(handle.db, webhook.id, { taskId: task.id, conversationId: conversation.id });
    await recordWebhookTrigger(handle.db, webhook.id, { taskId: task.id, conversationId: conversation.id });
    const after = await getWebhookForUser(handle.db, userId, webhook.id);
    expect(after).toMatchObject({ triggerCount: 2, lastTaskId: task.id, conversationId: conversation.id });
    expect(after?.lastTriggeredAt).not.toBeNull();
  });
});
