import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatRequest } from "@aiw/ai";
import { getTask, listAgentsForUser, listSubTasks, listToolCallsForTask, updateAgentForUser, type DatabaseHandle } from "@aiw/database";
import { createBuiltinToolRegistry } from "@aiw/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime, ensureBuiltinAgents, InProcessTaskExecutor, TaskService } from "../src";
import { createUser, eventRecorder, openTestDatabase, registryFor, ScriptedProvider, type Handler } from "./helpers";

let handle: DatabaseHandle;
let workspaceRoot: string;

beforeAll(async () => {
  handle = openTestDatabase();
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aiw-delegate-"));
});
afterAll(async () => {
  await handle.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function setup(handler: Handler, limits?: { maxDepth?: number; maxDelegationsPerTask?: number }) {
  const provider = new ScriptedProvider(handler);
  const registry = registryFor(provider);
  const { events } = eventRecorder(handle);
  const tools = createBuiltinToolRegistry({
    terminal: { enabled: false, allowedCommands: [], defaultTimeoutMs: 5_000 },
    web: { allowPrivateNetwork: false, search: null },
  });
  const runtime = new AgentRuntime({
    db: handle.db,
    registry,
    events,
    tools,
    workspaceRoot,
    retryDelaysMs: [],
    ...(limits ? { delegation: limits } : {}),
  });
  const executor = new InProcessTaskExecutor(runtime);
  const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: 3 });
  const userId = await createUser(handle);
  await ensureBuiltinAgents(handle.db, userId);
  const agents = await listAgentsForUser(handle.db, userId);
  const manager = agents.find((a) => a.slug === "manager")!;
  const file = agents.find((a) => a.slug === "file")!;
  for (const agent of [manager, file]) {
    await updateAgentForUser(handle.db, userId, agent.id, { provider: "scripted", planningMode: "never" });
  }
  const runTask = async (prompt: string) => {
    const created = await service.createTask(userId, { prompt, agentId: manager.id });
    const status = await executor.waitFor(created.task.id);
    return { taskId: created.task.id, status };
  };
  return { provider, userId, manager, file, runTask, executor, service };
}

/** Replies as the manager or the specialist depending on which system prompt the call carries. */
function team(manager: (request: ChatRequest) => ReturnType<Handler>, specialist: string): Handler {
  return (request) => (request.system?.includes("project manager") ? manager(request) : specialist);
}

describe("agent-to-agent delegation", () => {
  it("runs a real sub-task with the other agent and returns its result", async () => {
    let turn = 0;
    const env = await setup(
      team(() => {
        turn += 1;
        return turn === 1
          ? { toolCalls: [{ name: "agent.delegate", arguments: { agent: "file", task: "Draft a haiku about disks." } }] }
          : "The File Agent wrote the haiku.";
      }, "Spinning platters hum."),
    );

    const { taskId, status } = await env.runTask("Get a haiku written by the file specialist.");
    expect(status).toBe("completed");

    const subTasks = await listSubTasks(handle.db, taskId);
    expect(subTasks).toHaveLength(1);
    const sub = subTasks[0]!;
    expect(sub.status).toBe("completed");
    expect(sub.agentId).toBe(env.file.id);
    expect(sub.parentTaskId).toBe(taskId);
    expect(sub.depth).toBe(1);
    expect(sub.prompt).toContain("haiku about disks");
    expect(sub.result).toBe("Spinning platters hum.");

    // The manager saw the specialist's answer as the tool result.
    const call = (await listToolCallsForTask(handle.db, taskId)).find((c) => c.toolName === "agent.delegate")!;
    expect(call.status).toBe("completed");
    expect(call.summary).toContain("File Agent");
    expect((call.output as { taskId: string }).taskId).toBe(sub.id);

    // The sub-task is billed separately and its cost is its own.
    expect(sub.inputTokens).toBeGreaterThan(0);
    expect((await getTask(handle.db, taskId))?.result).toBe("The File Agent wrote the haiku.");
  });

  it("refuses to delegate deeper than the limit", async () => {
    // The specialist is also told it is a manager here, so it would delegate if allowed.
    const env = await setup(
      (request) =>
        request.messages.some((m) => m.role === "tool")
          ? "Finished after the refusal."
          : { toolCalls: [{ name: "agent.delegate", arguments: { agent: "file", task: "Do the thing." } }] },
      { maxDepth: 0 },
    );
    const { taskId, status } = await env.runTask("Delegate something.");
    expect(status).toBe("completed");
    expect(await listSubTasks(handle.db, taskId)).toHaveLength(0);
    const call = (await listToolCallsForTask(handle.db, taskId)).find((c) => c.toolName === "agent.delegate")!;
    expect(call.status).toBe("failed");
    expect(call.error).toContain("only allowed 0 level(s) deep");
  });

  it("stops after the delegation limit for one task", async () => {
    let turn = 0;
    const env = await setup(
      team(() => {
        turn += 1;
        return turn <= 3
          ? { toolCalls: [{ name: "agent.delegate", arguments: { agent: "file", task: `Piece ${turn}.` } }] }
          : "Done with what I could delegate.";
      }, "Piece done."),
      { maxDelegationsPerTask: 2 },
    );
    const { taskId, status } = await env.runTask("Delegate three pieces.");
    expect(status).toBe("completed");
    expect(await listSubTasks(handle.db, taskId)).toHaveLength(2);
    const calls = (await listToolCallsForTask(handle.db, taskId)).filter((c) => c.toolName === "agent.delegate");
    expect(calls.filter((c) => c.status === "completed")).toHaveLength(2);
    expect(calls.find((c) => c.status === "failed")?.error).toContain("already delegated 2 times");
  });

  it("tells the manager plainly when the sub-task fails", async () => {
    const env = await setup(
      team(
        (request) =>
          request.messages.some((m) => m.role === "tool")
            ? "The specialist could not do it, so nothing was written."
            : { toolCalls: [{ name: "agent.delegate", arguments: { agent: "file", task: "Delete everything." } }] },
        // The specialist calls a tool it was never given.
        "unused",
      ),
      {},
    );
    // Make the specialist fail by removing its model provider.
    await updateAgentForUser(handle.db, env.userId, env.file.id, { provider: "nonexistent" });

    const { taskId, status } = await env.runTask("Ask the file agent to do something.");
    expect(status).toBe("completed");
    const sub = (await listSubTasks(handle.db, taskId))[0]!;
    expect(sub.status).toBe("failed");
    const call = (await listToolCallsForTask(handle.db, taskId)).find((c) => c.toolName === "agent.delegate")!;
    expect(call.status).toBe("completed");
    expect((call.output as { status: string }).status).toBe("failed");
  });

  it("refuses an unknown agent and names the ones that exist", async () => {
    const env = await setup(
      team(
        (request) => (request.messages.some((m) => m.role === "tool") ? "No such agent, so I did it myself." : { toolCalls: [{ name: "agent.delegate", arguments: { agent: "nobody", task: "x" } }] }),
        "unused",
      ),
    );
    const { taskId } = await env.runTask("Delegate to nobody.");
    const call = (await listToolCallsForTask(handle.db, taskId)).find((c) => c.toolName === "agent.delegate")!;
    expect(call.status).toBe("failed");
    expect(call.error).toContain("no enabled agent");
    expect(call.error).toContain("research");
    expect(await listSubTasks(handle.db, taskId)).toHaveLength(0);
  });

  it("does not give the sub-agent the parent conversation", async () => {
    const seen: ChatRequest[] = [];
    const env = await setup(
      team(
        (request) => {
          seen.push(request);
          return request.messages.some((m) => m.role === "tool")
            ? "Done."
            : { toolCalls: [{ name: "agent.delegate", arguments: { agent: "file", task: "Write one word." } }] };
        },
        "Word.",
      ),
    );
    await env.runTask("Delegate a word.");
    const subRequests = env.provider.requests.filter((r) => !r.request.system?.includes("project manager"));
    expect(subRequests.length).toBeGreaterThan(0);
    for (const { request } of subRequests) {
      expect(request.messages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(JSON.stringify(request.messages)).not.toContain("Delegate a word");
    }
  });
});
