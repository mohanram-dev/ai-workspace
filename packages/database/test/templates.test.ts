import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countTemplatesForUser,
  createDatabase,
  createTemplate,
  deleteTemplateForUser,
  getTemplateForUser,
  listTemplatesForUser,
  markTemplateUsed,
  updateTemplateForUser,
  type DatabaseHandle,
} from "../src";
import { agents, users } from "../src/schema";
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

describe("prompt template repository", () => {
  it("scopes every read and write to the owner", async () => {
    const owner = await createUser();
    const other = await createUser();
    const template = await createTemplate(handle.db, { userId: owner, name: "Weekly report", prompt: "Summarise {{team}}" });

    expect(await getTemplateForUser(handle.db, other, template.id)).toBeNull();
    expect(await updateTemplateForUser(handle.db, other, template.id, { name: "Hijacked" })).toBeNull();
    expect(await markTemplateUsed(handle.db, other, template.id)).toBe(false);
    expect(await deleteTemplateForUser(handle.db, other, template.id)).toBe(false);
    expect(await listTemplatesForUser(handle.db, other)).toEqual([]);

    expect((await getTemplateForUser(handle.db, owner, template.id))?.name).toBe("Weekly report");
    expect(await countTemplatesForUser(handle.db, owner)).toBe(1);
    expect(await deleteTemplateForUser(handle.db, owner, template.id)).toBe(true);
    expect(await countTemplatesForUser(handle.db, owner)).toBe(0);
  });

  it("lists recently used templates first, then the rest by name", async () => {
    const userId = await createUser();
    const beta = await createTemplate(handle.db, { userId, name: "Beta", prompt: "b" });
    await createTemplate(handle.db, { userId, name: "Alpha", prompt: "a" });
    await createTemplate(handle.db, { userId, name: "Gamma", prompt: "g" });
    await markTemplateUsed(handle.db, userId, beta.id);

    expect((await listTemplatesForUser(handle.db, userId)).map((t) => t.name)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("names the agent, and forgets it when the agent is deleted", async () => {
    const userId = await createUser();
    const [agent] = await handle.db.insert(agents).values({ ownerId: userId, slug: "writer", name: "Writer", description: "d" }).returning();
    const template = await createTemplate(handle.db, { userId, name: "Draft", prompt: "Draft a post", agentId: agent!.id });
    expect((await getTemplateForUser(handle.db, userId, template.id))?.agentName).toBe("Writer");

    await handle.db.delete(agents).where(eq(agents.id, agent!.id));
    expect(await getTemplateForUser(handle.db, userId, template.id)).toMatchObject({ agentId: null, agentName: null });
  });
});
