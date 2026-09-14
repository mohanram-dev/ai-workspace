import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "@aiw/ai";
import {
  getScreenshotForUser,
  getTask,
  listAgentsForUser,
  listScreenshotsForTask,
  listTaskEvents,
  listToolCallsForTask,
  updateAgentForUser,
  type DatabaseHandle,
} from "@aiw/database";
import { z } from "zod";
import { createBuiltinToolRegistry, Workspace, type AnyToolDefinition, type ToolSource } from "@aiw/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime, ensureBuiltinAgents, InProcessTaskExecutor, TaskService, type TaskBusMessage } from "../src";
import { createUser, eventRecorder, openTestDatabase, registryFor, ScriptedProvider, type Handler } from "./helpers";

let handle: DatabaseHandle;
let workspaceRoot: string;

beforeAll(async () => {
  handle = openTestDatabase();
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aiw-agent-ws-"));
});
afterAll(async () => {
  await handle.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function setup(
  handler: Handler,
  agentChanges: { tools?: string[]; permissions?: string[]; maxToolCalls?: number } = {},
  toolSources: ToolSource[] = [],
) {
  const provider = new ScriptedProvider(handler);
  const registry = registryFor(provider);
  const { bus, events } = eventRecorder(handle);
  const tools = createBuiltinToolRegistry({
    terminal: { enabled: true, allowedCommands: ["node"], defaultTimeoutMs: 20_000 },
    web: { allowPrivateNetwork: false, search: null },
  });
  const runtime = new AgentRuntime({ db: handle.db, registry, events, tools, toolSources, workspaceRoot, retryDelaysMs: [] });
  const executor = new InProcessTaskExecutor(runtime);
  const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: 3 });
  const userId = await createUser(handle);
  await ensureBuiltinAgents(handle.db, userId);
  const coding = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "coding")!;
  await updateAgentForUser(handle.db, userId, coding.id, {
    provider: "scripted",
    planningMode: "never",
    tools: agentChanges.tools ?? coding.tools,
    permissions: agentChanges.permissions ?? coding.permissions,
    maxToolCalls: agentChanges.maxToolCalls ?? 20,
  });
  const workspace = Workspace.forUser(workspaceRoot, userId);
  const messages: TaskBusMessage[] = [];
  const runTask = async (prompt: string) => {
    const created = await service.createTask(userId, { prompt, agentId: coding.id });
    bus.subscribe(created.task.id, (m) => messages.push(m));
    const status = await executor.waitFor(created.task.id);
    return { taskId: created.task.id, status, created };
  };
  return { provider, service, executor, userId, coding, workspace, messages, runTask };
}

/** Handler that plays a fixed sequence of replies for step calls. */
function sequence(replies: Awaited<ReturnType<Handler>>[]): Handler {
  let index = 0;
  return () => replies[Math.min(index++, replies.length - 1)]!;
}

const toolMessages = (messages: ChatMessage[]) => messages.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");

describe("agent tool loop", () => {
  it("calls tools, feeds results back and records everything", async () => {
    const env = await setup(
      sequence([
        { text: "Creating the file.", toolCalls: [{ name: "files.write", arguments: { path: "notes/todo.md", content: "- buy milk\n" } }] },
        { toolCalls: [{ name: "files.read", arguments: { path: "notes/todo.md" } }] },
        "I created notes/todo.md containing one item: buy milk.",
      ]),
    );
    const { taskId, status } = await env.runTask("Create a todo file");
    expect(status).toBe("completed");
    expect(await readFile(path.join(env.workspace.root, "notes/todo.md"), "utf8")).toBe("- buy milk\n");
    expect((await getTask(handle.db, taskId))?.result).toBe("I created notes/todo.md containing one item: buy milk.");

    // Tools were declared, and results plus thought signatures were sent back.
    const stepRequests = env.provider.calls("step");
    expect(stepRequests).toHaveLength(3);
    expect(stepRequests[0]!.request.tools?.map((t) => t.name)).toContain("files.write");
    expect(stepRequests[0]!.request.system).toContain("- files.write:");
    const last = stepRequests[2]!.request.messages;
    const assistantTurns = last.filter((m) => m.role === "assistant");
    expect(assistantTurns[0]).toMatchObject({ toolCalls: [{ name: "files.write", providerMetadata: { thoughtSignature: "sig" } }] });
    const results = toolMessages(last);
    expect(results.map((m) => m.name)).toEqual(["files.write", "files.read"]);
    expect(results[1]!.content).toContain("- buy milk");

    const calls = await listToolCallsForTask(handle.db, taskId);
    expect(calls.map((c) => [c.toolName, c.status, c.permission])).toEqual([
      ["files.write", "completed", "WRITE"],
      ["files.read", "completed", "READ"],
    ]);
    expect(calls[0]!.summary).toBe("Created notes/todo.md (11 bytes)");

    const types = (await listTaskEvents(handle.db, taskId)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["TOOL_CALL_STARTED", "FILE_CREATED", "TOOL_CALL_FINISHED", "FILE_READ"]),
    );
    const created = (await listTaskEvents(handle.db, taskId)).find((e) => e.type === "FILE_CREATED")!;
    expect(created).toMatchObject({ toolName: "files.write", description: "Created notes/todo.md" });
    expect(created.data).toMatchObject({ path: "notes/todo.md", toolCallId: calls[0]!.id });
  });

  it("denies ungranted actions, and refuses destructive ones when no approver is configured", async () => {
    const env = await setup(
      sequence([
        { toolCalls: [{ name: "files.write", arguments: { path: "x.txt", content: "x" } }, { name: "files.delete", arguments: { path: "keep.txt" } }] },
        "I could not write or delete files.",
      ]),
      { permissions: [] },
    );
    await mkdir(env.workspace.root, { recursive: true });
    await writeFile(path.join(env.workspace.root, "keep.txt"), "important");

    const { taskId, status } = await env.runTask("Write and delete");
    expect(status).toBe("completed");
    expect(existsSync(path.join(env.workspace.root, "x.txt"))).toBe(false);
    expect(existsSync(path.join(env.workspace.root, "keep.txt"))).toBe(true);

    const calls = await listToolCallsForTask(handle.db, taskId);
    expect(calls.map((c) => [c.toolName, c.status, c.errorCode])).toEqual([
      ["files.write", "denied", "not_granted"],
      ["files.delete", "denied", "requires_approval"],
    ]);
    const results = toolMessages(env.provider.calls("step")[1]!.request.messages);
    expect(results[0]!.content).toContain("WRITE permission");
    // Without an ApprovalService (Phase 8) a destructive call cannot be approved, so it is refused.
    expect(results[1]!.content).toContain("human approval");
    const finished = (await listTaskEvents(handle.db, taskId)).filter((e) => e.type === "TOOL_CALL_FINISHED");
    expect(finished.every((e) => e.status === "warning")).toBe(true);
  });

  it("rejects unassigned tools and invalid arguments without running them", async () => {
    const env = await setup(
      sequence([
        { toolCalls: [{ name: "web.fetch", arguments: { url: "https://example.com" } }, { name: "files.read", arguments: { wrong: true } }] },
        "Done.",
      ]),
      { tools: ["files.read"] },
    );
    const { taskId } = await env.runTask("Try things");
    const calls = await listToolCallsForTask(handle.db, taskId);
    expect(calls.map((c) => [c.toolName, c.status, c.errorCode])).toEqual([
      ["web.fetch", "denied", "not_found"],
      ["files.read", "failed", "invalid_input"],
    ]);
    expect(env.provider.calls("step")[0]!.request.tools?.map((t) => t.name)).toEqual(["files.read"]);
  });

  it("stops offering tool calls once the limit is reached", async () => {
    const env = await setup((request) => {
      if (request.toolChoice === "none") return "Finished after the limit.";
      return { toolCalls: [{ name: "files.list", arguments: {} }] };
    }, { maxToolCalls: 2 });
    const { taskId, status } = await env.runTask("Loop forever");
    expect(status).toBe("completed");
    expect(await listToolCallsForTask(handle.db, taskId)).toHaveLength(2);
    const lastRequest = env.provider.calls("step").at(-1)!.request;
    expect(lastRequest.toolChoice).toBe("none");
    expect(lastRequest.messages.at(-1)).toMatchObject({ role: "user" });
    expect((lastRequest.messages.at(-1) as { content: string }).content).toContain("limit of 2 tool calls");
  });

  it("streams terminal output and records command events", async () => {
    const env = await setup(
      sequence([
        { toolCalls: [{ name: "terminal.run", arguments: { program: "node", args: ["-e", "console.log('from node')"] } }] },
        "The command printed 'from node'.",
      ]),
    );
    const { taskId, status } = await env.runTask("Run node");
    expect(status).toBe("completed");
    const [call] = await listToolCallsForTask(handle.db, taskId);
    expect(call).toMatchObject({ toolName: "terminal.run", status: "completed", permission: "EXECUTE" });
    expect(call!.output).toMatchObject({ exitCode: 0, stdout: "from node\n" });
    const terminal = env.messages.filter((m) => m.kind === "terminal");
    expect(terminal.map((m) => (m.kind === "terminal" ? m.output.text : "")).join("")).toContain("from node");
    const types = (await listTaskEvents(handle.db, taskId)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["TERMINAL_COMMAND_STARTED", "TERMINAL_COMMAND_FINISHED"]));
  });

  it("cancels a running command when the task is stopped", async () => {
    const env = await setup(sequence([{ toolCalls: [{ name: "terminal.run", arguments: { program: "node", args: ["-e", "setTimeout(() => {}, 20000)"] } }] }]));
    const created = await env.service.createTask(env.userId, { prompt: "Long command", agentId: env.coding.id });
    for (let i = 0; i < 200; i++) {
      const calls = await listToolCallsForTask(handle.db, created.task.id);
      if (calls.some((c) => c.status === "running" && c.permission)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 200));
    await env.service.stopTask(env.userId, created.task.id);
    expect(await env.executor.waitFor(created.task.id)).toBe("cancelled");
    const [call] = await listToolCallsForTask(handle.db, created.task.id);
    expect(call).toMatchObject({ status: "cancelled" });
  }, 20_000);

  it("tells later steps which tool actions were already performed", async () => {
    let stepCalls = 0;
    const env = await setup((request, kind) => {
      if (kind === "planning") return JSON.stringify({ steps: [{ title: "Create", instruction: "Create the file" }, { title: "Check", instruction: "Check it" }] });
      stepCalls++;
      if (stepCalls === 1) return { toolCalls: [{ name: "files.write", arguments: { path: "a.txt", content: "A" } }, { name: "files.delete", arguments: { path: "a.txt" } }, { name: "files.delete", arguments: { path: "b.txt" } }] };
      return "done";
    });
    await updateAgentForUser(handle.db, env.userId, env.coding.id, { planningMode: "always", maxSteps: 3 });
    const { status } = await env.runTask("Create and check a file");
    expect(status).toBe("completed");
    const laterPrompt = env.provider.calls("step").at(-1)!.request.messages.at(-1) as { content: string };
    expect(laterPrompt.content).toContain("## Actions already performed in this task");
    expect(laterPrompt.content).toContain("files.write: Created a.txt (1 bytes)");
    expect(laterPrompt.content).toContain("files.delete: DENIED (requires_approval)");
    expect(laterPrompt.content.match(/files.delete: DENIED/g)).toHaveLength(1);
    expect(laterPrompt.content).toContain("Do not retry DENIED actions");
  });

  it("sends no tools to agents without tool assignments", async () => {
    const env = await setup(() => "Plain answer.", { tools: [] });
    const { status } = await env.runTask("Just talk");
    expect(status).toBe("completed");
    const request = env.provider.calls("step")[0]!.request;
    expect(request.tools).toBeUndefined();
    expect(request.system).toContain("You currently have NO tools");
  });

  it("uses per-user tools from tool sources, with their permissions and activity events", async () => {
    const seenUsers: string[] = [];
    const sourceTool = (name: string, options: { permission?: "READ" | "EXECUTE"; available?: boolean } = {}): AnyToolDefinition => ({
      name,
      description: `[MCP: Demo] ${name}`,
      category: "mcp",
      inputSchema: z.object({ q: z.string() }),
      permission: options.permission ?? "READ",
      timeoutMs: 5000,
      availability: () => (options.available === false ? { available: false, reason: "disabled" } : { available: true }),
      execute: async (input: { q: string }, context) => {
        context.report({ type: "MCP_TOOL_STARTED", serverId: "s1", serverName: "Demo", tool: name });
        context.report({ type: "MCP_TOOL_FINISHED", serverId: "s1", serverName: "Demo", tool: name, isError: false, durationMs: 3 });
        return { output: { answer: input.q.toUpperCase() }, summary: `Demo · ${name}: ok`, content: input.q.toUpperCase() };
      },
    });
    const source: ToolSource = {
      toolsForUser: async (userId) => {
        seenUsers.push(userId);
        return [sourceTool("demo.lookup"), sourceTool("demo.run", { permission: "EXECUTE" }), sourceTool("demo.off", { available: false }), sourceTool("demo.unassigned")];
      },
    };
    const env = await setup(
      sequence([
        { toolCalls: [{ name: "demo.lookup", arguments: { q: "hello" } }, { name: "demo.run", arguments: { q: "x" } }] },
        "Looked it up.",
      ]),
      { tools: ["files.read", "demo.lookup", "demo.run", "demo.off"], permissions: [] },
      [source],
    );
    const { taskId, status } = await env.runTask("Use the demo server");
    expect(status).toBe("completed");
    expect(seenUsers).toEqual([env.userId]);

    const declared = env.provider.calls("step")[0]!.request.tools?.map((t) => t.name);
    expect(declared).toEqual(["files.read", "demo.lookup", "demo.run"]);
    expect(env.provider.calls("step")[0]!.request.system).toContain("run on external MCP servers");

    const calls = await listToolCallsForTask(handle.db, taskId);
    expect(calls.map((c) => [c.toolName, c.status, c.category, c.permission, c.errorCode])).toEqual([
      ["demo.lookup", "completed", "mcp", "READ", null],
      ["demo.run", "denied", "mcp", "EXECUTE", "not_granted"],
    ]);
    expect(toolMessages(env.provider.calls("step")[1]!.request.messages)[0]!.content).toBe("HELLO");

    const events = await listTaskEvents(handle.db, taskId);
    const started = events.find((e) => e.type === "MCP_TOOL_STARTED")!;
    const finished = events.find((e) => e.type === "MCP_TOOL_FINISHED")!;
    expect(started).toMatchObject({ status: "running", toolName: "demo.lookup", description: "Calling MCP tool demo.lookup on Demo" });
    expect(started.data).toMatchObject({ toolCallId: calls[0]!.id, serverName: "Demo", tool: "demo.lookup" });
    expect(finished).toMatchObject({ status: "success", durationMs: 3 });
  });
});

describe("browser activity", () => {
  it("stores screenshots, emits browser events and releases resources when the task ends", async () => {
    const released: string[] = [];
    const image = Buffer.from("fake-jpeg-bytes");
    const browserTool: AnyToolDefinition = {
      name: "browser.open",
      description: "Open a page",
      category: "browser",
      inputSchema: z.object({ url: z.string() }),
      permission: "NETWORK",
      timeoutMs: 5000,
      availability: () => ({ available: true }),
      execute: async (input: { url: string }, context) => {
        context.report({ type: "BROWSER_OPENED" });
        context.report({ type: "PAGE_NAVIGATED", url: input.url, title: "Example" });
        context.report({ type: "BROWSER_ACTION", action: "click", target: '[1] a "Next"', url: input.url });
        context.report({ type: "BROWSER_SCREENSHOT", url: input.url, title: "Example", width: 10, height: 5, mimeType: "image/jpeg", image, reason: "open" });
        return { output: { url: input.url }, summary: "Opened Example", content: "URL: x" };
      },
    };
    const provider = new ScriptedProvider(sequence([{ toolCalls: [{ name: "browser.open", arguments: { url: "https://example.com" } }] }, "Done."]));
    const registry = registryFor(provider);
    const { bus, events } = eventRecorder(handle);
    const tools = createBuiltinToolRegistry({ terminal: { enabled: false, allowedCommands: [], defaultTimeoutMs: 1000 }, web: { allowPrivateNetwork: false, search: null } });
    tools.register(browserTool);
    const runtime = new AgentRuntime({ db: handle.db, registry, events, tools, workspaceRoot, retryDelaysMs: [], onTaskEnd: async (id) => void released.push(id) });
    const executor = new InProcessTaskExecutor(runtime);
    const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: 3 });
    const userId = await createUser(handle);
    await ensureBuiltinAgents(handle.db, userId);
    const browser = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "browser")!;
    expect(browser.tools).toContain("browser.click");
    await updateAgentForUser(handle.db, userId, browser.id, { provider: "scripted", planningMode: "never" });

    const messages: TaskBusMessage[] = [];
    const created = await service.createTask(userId, { prompt: "Open example.com", agentId: browser.id });
    bus.subscribe(created.task.id, (m) => messages.push(m));
    events.browserFrame({ taskId: created.task.id, seq: 1, url: "https://example.com", title: "Example", width: 10, height: 5, capturedAt: new Date().toISOString() });
    expect(await executor.waitFor(created.task.id)).toBe("completed");
    expect(released).toEqual([created.task.id]);

    const shots = await listScreenshotsForTask(handle.db, created.task.id);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ url: "https://example.com", title: "Example", width: 10, height: 5, bytes: image.length, reason: "open" });
    const stored = await getScreenshotForUser(handle.db, userId, created.task.id, shots[0]!.id);
    expect(Buffer.from(stored!.image).equals(image)).toBe(true);
    expect(await getScreenshotForUser(handle.db, "someone-else", created.task.id, shots[0]!.id)).toBeNull();

    const recorded = await listTaskEvents(handle.db, created.task.id);
    const types = recorded.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["BROWSER_OPENED", "PAGE_NAVIGATED", "BROWSER_ACTION", "BROWSER_SCREENSHOT"]));
    const shotEvent = recorded.find((e) => e.type === "BROWSER_SCREENSHOT")!;
    expect(shotEvent.data).toMatchObject({ screenshotId: shots[0]!.id, url: "https://example.com", width: 10 });
    expect(shotEvent.data).not.toHaveProperty("image");
    expect(recorded.find((e) => e.type === "BROWSER_ACTION")!.description).toBe('Clicking [1] a "Next"');
    expect(messages.some((m) => m.kind === "browser" && m.frame.seq === 1)).toBe(true);
  });
});
