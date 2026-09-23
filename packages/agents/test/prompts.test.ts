import { readFileSync } from "node:fs";
import { listAgentsForUser, schema, type DatabaseHandle } from "@aiw/database";
import { and, eq, sql as rawSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS, ensureBuiltinAgents } from "../src";
import { buildToolsNotice } from "../src/prompts";
import { createUser, openTestDatabase } from "./helpers";

const tool = (name: string, category: string) => ({ name, description: `${name} tool`, category });

describe("tool notice (what an agent is told it can do)", () => {
  it("says destructive actions wait for approval, now that approvals exist", () => {
    const notice = buildToolsNotice([tool("files.delete", "files")]);
    expect(notice).toContain("wait for the user's approval");
    expect(notice).not.toContain("human approval is not available");
  });

  it("does not tell the Computer Use agent it cannot control the desktop", () => {
    const computer = BUILTIN_AGENTS.find((a) => a.slug === "computer-use")!;
    const notice = buildToolsNotice(computer.tools.map((name) => tool(name, "computer")));
    expect(notice).not.toMatch(/cannot[^\n]*desktop/i);
    expect(notice).toContain("computer.start");
  });

  it("still tells other agents what they lack", () => {
    const notice = buildToolsNotice([tool("files.read", "files")]);
    expect(notice).toMatch(/You cannot [^\n]*control the desktop, mouse or keyboard/);
    expect(notice).toMatch(/You cannot [^\n]*search the web/);
  });

  it("does not tell the Research Agent it has no live sources", () => {
    const research = BUILTIN_AGENTS.find((a) => a.slug === "research")!;
    expect(research.tools).toContain("web.search");
    expect(research.instructions).not.toContain("cannot access live sources");
  });
});

describe("migration 0016 (Research Agent instructions)", () => {
  const OLD =
    "You are a meticulous research analyst. Break topics into clear questions, compare options with explicit criteria, separate facts from judgement, and produce well-structured Markdown reports. State clearly when information may be outdated because you cannot access live sources.";
  const sql = readFileSync(new URL("../../database/migrations/0016_research_agent_instructions.sql", import.meta.url), "utf8");
  let handle: DatabaseHandle;
  beforeAll(() => {
    handle = openTestDatabase();
  });
  afterAll(async () => {
    await handle.close();
  });

  async function researchAgentWith(instructions: string) {
    const userId = await createUser(handle);
    await ensureBuiltinAgents(handle.db, userId);
    await handle.db
      .update(schema.agents)
      .set({ instructions })
      .where(and(eq(schema.agents.ownerId, userId), eq(schema.agents.slug, "research")));
    return userId;
  }
  const instructionsOf = async (userId: string) =>
    (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "research")!.instructions;

  it("rewrites the old default and leaves an edited instruction alone", async () => {
    const untouched = await researchAgentWith(OLD);
    const edited = await researchAgentWith("My own research instructions.");

    await handle.db.execute(rawSql.raw(sql));

    const current = BUILTIN_AGENTS.find((a) => a.slug === "research")!.instructions;
    expect(await instructionsOf(untouched)).toBe(current);
    expect(await instructionsOf(edited)).toBe("My own research instructions.");
  });
});
