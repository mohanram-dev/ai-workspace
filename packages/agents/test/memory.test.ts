import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createProject,
  listAgentsForUser,
  listMemories,
  listMemoriesForTask,
  rememberMemory,
  updateAgentForUser,
  type DatabaseHandle,
} from "@aiw/database";
import { createBuiltinToolRegistry } from "@aiw/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRuntime,
  buildMemoryNotice,
  createMemoryTools,
  ensureBuiltinAgents,
  InProcessTaskExecutor,
  projectWorkspace,
  TaskService,
} from "../src";
import { createUser, eventRecorder, openTestDatabase, registryFor, ScriptedProvider, type Handler } from "./helpers";

let handle: DatabaseHandle;
let workspaceRoot: string;

beforeAll(async () => {
  handle = openTestDatabase();
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aiw-memory-"));
});
afterAll(async () => {
  await handle.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function sequence(replies: Awaited<ReturnType<Handler>>[]): Handler {
  let index = 0;
  return () => replies[Math.min(index++, replies.length - 1)]!;
}

async function setup(handler: Handler, options: { withProject?: boolean } = {}) {
  const provider = new ScriptedProvider(handler);
  const registry = registryFor(provider);
  const { events } = eventRecorder(handle);
  const tools = createBuiltinToolRegistry({
    terminal: { enabled: false, allowedCommands: [], defaultTimeoutMs: 1000 },
    web: { allowPrivateNetwork: false, search: null },
  });
  for (const tool of createMemoryTools(handle.db)) tools.register(tool);
  const runtime = new AgentRuntime({ db: handle.db, registry, events, tools, workspaceRoot, retryDelaysMs: [] });
  const executor = new InProcessTaskExecutor(runtime);
  const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: 3 });
  const userId = await createUser(handle);
  await ensureBuiltinAgents(handle.db, userId);
  const agent = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "file")!;
  await updateAgentForUser(handle.db, userId, agent.id, {
    provider: "scripted",
    planningMode: "never",
    tools: [...agent.tools, "memory.remember", "memory.list", "memory.forget"],
  });
  const project = options.withProject ? await createProject(handle.db, { ownerId: userId, name: "Test project" }) : null;

  const runTask = async (prompt: string) => {
    const created = await service.createTask(userId, { prompt, agentId: agent.id, ...(project ? { projectId: project.id } : {}) });
    return created.task.id;
  };
  return { provider, executor, userId, agent, project, runTask };
}

describe("memory", () => {
  it("stores project facts the agent remembers, and replaces the value on rewrite", async () => {
    const env = await setup(
      sequence([
        { toolCalls: [{ name: "memory.remember", arguments: { key: "database", value: "PostgreSQL 16" } }] },
        { toolCalls: [{ name: "memory.remember", arguments: { key: "database", value: "PostgreSQL 17" } }] },
        "Noted.",
      ]),
      { withProject: true },
    );
    const taskId = await env.runTask("Remember the database");
    expect(await env.executor.waitFor(taskId)).toBe("completed");

    const stored = await listMemories(handle.db, env.userId, { scope: "project", projectId: env.project!.id });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ key: "database", value: "PostgreSQL 17", source: "agent", taskId });
  });

  it("falls back to agent memory outside a project, and forgets on request", async () => {
    const env = await setup(
      sequence([
        { toolCalls: [{ name: "memory.remember", arguments: { key: "style", value: "British English", scope: "project" } }] },
        { toolCalls: [{ name: "memory.forget", arguments: { key: "style", scope: "agent" } }] },
        "Done.",
      ]),
    );
    const taskId = await env.runTask("Remember my style");
    expect(await env.executor.waitFor(taskId)).toBe("completed");

    // No project on this task, so the project scope became agent scope.
    expect(await listMemories(handle.db, env.userId, { scope: "agent", agentId: env.agent.id })).toHaveLength(0);
  });

  it("puts what the agent remembers into its prompt", async () => {
    const env = await setup(sequence(["Fine."]), { withProject: true });
    await rememberMemory(handle.db, { userId: env.userId, scope: "project", projectId: env.project!.id, key: "deployment", value: "Coolify" });
    await rememberMemory(handle.db, { userId: env.userId, scope: "agent", agentId: env.agent.id, key: "tone", value: "concise" });

    const taskId = await env.runTask("Say hello");
    expect(await env.executor.waitFor(taskId)).toBe("completed");
    const system = env.provider.calls("step")[0]!.request.system ?? "";
    expect(system).toContain("## What you remember");
    expect(system).toContain("deployment: Coolify");
    expect(system).toContain("tone: concise");

    const forTask = await listMemoriesForTask(handle.db, env.userId, {
      agentId: env.agent.id,
      projectId: env.project!.id,
      conversationId: null,
    });
    expect(forTask.map((m) => m.key).sort()).toEqual(["deployment", "tone"]);
  });

  it("keeps a project's files in its own folder", async () => {
    const env = await setup(
      sequence([{ toolCalls: [{ name: "files.write", arguments: { path: "notes.md", content: "project note" } }] }, "Saved."]),
      { withProject: true },
    );
    const taskId = await env.runTask("Write a note");
    expect(await env.executor.waitFor(taskId)).toBe("completed");

    const projectRoot = projectWorkspace(workspaceRoot, env.userId, env.project!.id).root;
    const personalRoot = projectWorkspace(workspaceRoot, env.userId, null).root;
    expect(existsSync(path.join(projectRoot, "notes.md"))).toBe(true);
    expect(existsSync(path.join(personalRoot, "notes.md"))).toBe(false);
    expect(projectRoot.startsWith(personalRoot)).toBe(true);
  });

  it("formats the memory notice by scope", () => {
    expect(buildMemoryNotice([])).toBe("");
    const notice = buildMemoryNotice([
      { scope: "project", key: "database", value: "PostgreSQL" },
      { scope: "agent", key: "tone", value: "concise" },
    ]);
    expect(notice).toContain("### This project");
    expect(notice).toContain("- database: PostgreSQL");
    expect(notice).toContain("### You");
  });

  it("does not leak memory between users", async () => {
    const a = await setup(sequence(["ok"]), { withProject: true });
    const b = await setup(sequence(["ok"]), { withProject: true });
    await rememberMemory(handle.db, { userId: a.userId, scope: "project", projectId: a.project!.id, key: "secret", value: "alpha" });
    expect(await listMemories(handle.db, b.userId, { scope: "project", projectId: a.project!.id })).toHaveLength(0);
  });
});
