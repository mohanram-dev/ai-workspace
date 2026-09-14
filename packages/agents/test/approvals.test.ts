import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getTask,
  listAgentsForUser,
  listApprovalsForTask,
  listTaskEvents,
  listToolCallsForTask,
  updateAgentForUser,
  type DatabaseHandle,
} from "@aiw/database";
import { createBuiltinToolRegistry, decidePermission, Workspace } from "@aiw/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime, ApprovalService, ensureBuiltinAgents, InProcessTaskExecutor, TaskService } from "../src";
import { createUser, eventRecorder, openTestDatabase, registryFor, ScriptedProvider, type Handler } from "./helpers";

let handle: DatabaseHandle;
let workspaceRoot: string;

beforeAll(async () => {
  handle = openTestDatabase();
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aiw-approval-"));
});
afterAll(async () => {
  await handle.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function sequence(replies: Awaited<ReturnType<Handler>>[]): Handler {
  let index = 0;
  return () => replies[Math.min(index++, replies.length - 1)]!;
}

const deleteThenAnswer = (paths: string[]) =>
  sequence([{ toolCalls: paths.map((p) => ({ name: "files.delete", arguments: { path: p } })) }, "Done."]);

async function approvalEnv(handler: Handler, options: { timeoutMs?: number } = {}) {
  const provider = new ScriptedProvider(handler);
  const registry = registryFor(provider);
  const { bus, events } = eventRecorder(handle);
  const tools = createBuiltinToolRegistry({
    terminal: { enabled: false, allowedCommands: [], defaultTimeoutMs: 1000 },
    web: { allowPrivateNetwork: false, search: null },
  });
  const approvals = new ApprovalService({ db: handle.db, timeoutMs: options.timeoutMs ?? 30_000, pollMs: 50 });
  const runtime = new AgentRuntime({ db: handle.db, registry, events, tools, approvals, workspaceRoot, retryDelaysMs: [] });
  const executor = new InProcessTaskExecutor(runtime);
  const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: 3 });
  const userId = await createUser(handle);
  await ensureBuiltinAgents(handle.db, userId);
  const agent = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "file")!;
  await updateAgentForUser(handle.db, userId, agent.id, { provider: "scripted", planningMode: "never" });
  const workspace = Workspace.forUser(workspaceRoot, userId);
  await mkdir(workspace.root, { recursive: true });

  const runTask = async (prompt: string) => {
    const created = await service.createTask(userId, { prompt, agentId: agent.id });
    bus.subscribe(created.task.id, () => {});
    return created.task.id;
  };
  /** Waits for the task to raise its approval request. */
  const waitForApproval = async (taskId: string) => {
    // Generous: the whole workspace suite can be running, and this only polls.
    for (let i = 0; i < 800; i++) {
      const [pending] = await listApprovalsForTask(handle.db, taskId);
      if (pending?.status === "pending") return pending;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no approval request appeared");
  };
  return { approvals, service, executor, userId, agentId: agent.id, workspace, runTask, waitForApproval, provider };
}

const toolMessages = (messages: { role: string }[]) => messages.filter((m): m is { role: "tool"; content: string } & typeof m => m.role === "tool");

describe("permission engine", () => {
  it("allows READ, requires grants, and sends DESTRUCTIVE to a human", () => {
    expect(decidePermission("READ", [])).toEqual({ outcome: "allowed" });
    expect(decidePermission("WRITE", ["WRITE"])).toEqual({ outcome: "allowed" });
    expect(decidePermission("EXECUTE", ["WRITE"])).toMatchObject({ outcome: "denied", reason: "not_granted" });
    expect(decidePermission("DESTRUCTIVE", ["WRITE", "EXECUTE", "NETWORK"])).toMatchObject({ outcome: "needs_approval" });
    // "Approve for this task" skips later prompts for that tool only.
    expect(decidePermission("DESTRUCTIVE", [], { toolName: "files.delete", approvedForTask: ["files.delete"] })).toEqual({ outcome: "allowed" });
    expect(decidePermission("DESTRUCTIVE", [], { toolName: "files.delete", approvedForTask: ["git.push"] })).toMatchObject({ outcome: "needs_approval" });
  });
});

describe("human approval", () => {
  it("pauses on a destructive call, runs it after approval and records the decision", async () => {
    const env = await approvalEnv(deleteThenAnswer(["gone.txt"]));
    await writeFile(path.join(env.workspace.root, "gone.txt"), "bye");
    const taskId = await env.runTask("Delete gone.txt");

    const request = await env.waitForApproval(taskId);
    expect(request).toMatchObject({ toolName: "files.delete", permission: "DESTRUCTIVE", action: "files.delete: gone.txt", status: "pending" });
    expect((await getTask(handle.db, taskId))?.status).toBe("waiting_for_approval");
    expect((await listToolCallsForTask(handle.db, taskId))[0]).toMatchObject({ status: "awaiting_approval" });

    expect(await env.approvals.decide(request.id, { status: "approved", scope: "once", decidedBy: env.userId })).toMatchObject({
      status: "approved",
      scope: "once",
    });
    expect(await env.executor.waitFor(taskId)).toBe("completed");
    expect(existsSync(path.join(env.workspace.root, "gone.txt"))).toBe(false);
    expect((await listToolCallsForTask(handle.db, taskId))[0]).toMatchObject({ status: "completed" });

    const types = (await listTaskEvents(handle.db, taskId)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["APPROVAL_REQUIRED", "APPROVAL_GRANTED"]));
    // A second decision cannot overwrite the first.
    expect(await env.approvals.decide(request.id, { status: "rejected" })).toBeNull();
  });

  it("tells the agent why a rejected action did not run", async () => {
    const env = await approvalEnv(deleteThenAnswer(["keep.txt"]));
    await writeFile(path.join(env.workspace.root, "keep.txt"), "important");
    const taskId = await env.runTask("Delete keep.txt");

    const request = await env.waitForApproval(taskId);
    await env.approvals.decide(request.id, { status: "rejected", reason: "That file is needed.", decidedBy: env.userId });
    expect(await env.executor.waitFor(taskId)).toBe("completed");
    expect(existsSync(path.join(env.workspace.root, "keep.txt"))).toBe(true);

    expect((await listToolCallsForTask(handle.db, taskId))[0]).toMatchObject({ status: "denied", errorCode: "rejected" });
    const results = toolMessages(env.provider.calls("step")[1]!.request.messages);
    expect(results[0]!.content).toContain("rejected this action");
    expect(results[0]!.content).toContain("That file is needed.");
    expect((await listTaskEvents(handle.db, taskId)).find((e) => e.type === "APPROVAL_REJECTED")!.data).toMatchObject({
      reason: "That file is needed.",
      expired: false,
    });
  });

  it("approving for the task skips later prompts for the same tool", async () => {
    const env = await approvalEnv(deleteThenAnswer(["a.txt", "b.txt"]));
    await writeFile(path.join(env.workspace.root, "a.txt"), "a");
    await writeFile(path.join(env.workspace.root, "b.txt"), "b");
    const taskId = await env.runTask("Delete both files");

    const request = await env.waitForApproval(taskId);
    await env.approvals.decide(request.id, { status: "approved", scope: "task", decidedBy: env.userId });
    expect(await env.executor.waitFor(taskId)).toBe("completed");

    expect(existsSync(path.join(env.workspace.root, "a.txt"))).toBe(false);
    expect(existsSync(path.join(env.workspace.root, "b.txt"))).toBe(false);
    // Only the first call asked; the second ran on the task-wide approval.
    expect(await listApprovalsForTask(handle.db, taskId)).toHaveLength(1);
    expect((await listToolCallsForTask(handle.db, taskId)).map((c) => c.status)).toEqual(["completed", "completed"]);
  });

  it("expires when nobody decides", async () => {
    const env = await approvalEnv(deleteThenAnswer(["x.txt"]), { timeoutMs: 300 });
    await writeFile(path.join(env.workspace.root, "x.txt"), "x");
    const taskId = await env.runTask("Delete x.txt");

    expect(await env.executor.waitFor(taskId)).toBe("completed");
    expect(existsSync(path.join(env.workspace.root, "x.txt"))).toBe(true);
    expect((await listApprovalsForTask(handle.db, taskId))[0]).toMatchObject({ status: "expired" });
    expect((await listToolCallsForTask(handle.db, taskId))[0]).toMatchObject({ status: "denied", errorCode: "approval_expired" });
  });

  it("cancels the request when the task is stopped", async () => {
    const env = await approvalEnv(deleteThenAnswer(["y.txt"]));
    await writeFile(path.join(env.workspace.root, "y.txt"), "y");
    const taskId = await env.runTask("Delete y.txt");

    await env.waitForApproval(taskId);
    await env.service.stopTask(env.userId, taskId);
    expect(await env.executor.waitFor(taskId)).toBe("cancelled");
    expect((await listApprovalsForTask(handle.db, taskId))[0]).toMatchObject({ status: "cancelled" });
    expect(existsSync(path.join(env.workspace.root, "y.txt"))).toBe(true);
  }, 20_000);

  it("refuses destructive calls when approvals are not configured", async () => {
    const provider = new ScriptedProvider(deleteThenAnswer(["z.txt"]));
    const registry = registryFor(provider);
    const { events } = eventRecorder(handle);
    const tools = createBuiltinToolRegistry({
      terminal: { enabled: false, allowedCommands: [], defaultTimeoutMs: 1000 },
      web: { allowPrivateNetwork: false, search: null },
    });
    const runtime = new AgentRuntime({ db: handle.db, registry, events, tools, workspaceRoot, retryDelaysMs: [] });
    const executor = new InProcessTaskExecutor(runtime);
    const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: 3 });
    const userId = await createUser(handle);
    await ensureBuiltinAgents(handle.db, userId);
    const agent = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "file")!;
    await updateAgentForUser(handle.db, userId, agent.id, { provider: "scripted", planningMode: "never" });
    const workspace = Workspace.forUser(workspaceRoot, userId);
    await mkdir(workspace.root, { recursive: true });
    await writeFile(path.join(workspace.root, "z.txt"), "z");

    const created = await service.createTask(userId, { prompt: "Delete z.txt", agentId: agent.id });
    expect(await executor.waitFor(created.task.id)).toBe("completed");
    expect(existsSync(path.join(workspace.root, "z.txt"))).toBe(true);
    expect(await listApprovalsForTask(handle.db, created.task.id)).toHaveLength(0);
    expect((await listToolCallsForTask(handle.db, created.task.id))[0]).toMatchObject({ status: "denied", errorCode: "requires_approval" });
  });
});

describe("autonomous mode (spec §27)", () => {
  it("runs a trusted destructive tool without asking, and records that it did", async () => {
    const env = await approvalEnv(deleteThenAnswer(["auto.txt"]));
    await updateAgentForUser(handle.db, env.userId, env.agentId, {
      autonomousMode: true,
      trustedTools: ["files.delete"],
    });
    await writeFile(path.join(env.workspace.root, "auto.txt"), "bye");

    const taskId = await env.runTask("Delete auto.txt");
    expect(await env.executor.waitFor(taskId)).toBe("completed");

    // It really ran, and nobody was asked.
    expect(existsSync(path.join(env.workspace.root, "auto.txt"))).toBe(false);
    expect(await listApprovalsForTask(handle.db, taskId)).toHaveLength(0);
    expect((await listToolCallsForTask(handle.db, taskId))[0]).toMatchObject({ status: "completed" });

    // But it is on the record (timeline + audit log), not silent.
    const events = await listTaskEvents(handle.db, taskId);
    const autonomous = events.find((e) => e.type === "AUTONOMOUS_ACTION");
    expect(autonomous?.description).toContain("Ran without asking");
    expect(autonomous?.data).toMatchObject({ toolName: "files.delete", permission: "DESTRUCTIVE" });
    expect(events.some((e) => e.type === "APPROVAL_REQUIRED")).toBe(false);
  });

  it("still asks for a destructive tool the user did not trust", async () => {
    const env = await approvalEnv(deleteThenAnswer(["untrusted.txt"]));
    await updateAgentForUser(handle.db, env.userId, env.agentId, {
      autonomousMode: true,
      trustedTools: ["git.commit"],
    });
    await writeFile(path.join(env.workspace.root, "untrusted.txt"), "keep");

    const taskId = await env.runTask("Delete untrusted.txt");
    const request = await env.waitForApproval(taskId);
    expect(request.toolName).toBe("files.delete");
    await env.approvals.decide(request.id, { status: "rejected", decidedBy: env.userId });
    expect(await env.executor.waitFor(taskId)).toBe("completed");
    expect(existsSync(path.join(env.workspace.root, "untrusted.txt"))).toBe(true);
  });

  it("never runs terminal.run unattended, however it is configured", () => {
    // The floor is enforced in the engine, so no configuration can lower it.
    expect(
      decidePermission("DESTRUCTIVE", ["EXECUTE"], {
        toolName: "terminal.run",
        autonomous: { enabled: true, trustedTools: ["terminal.run"] },
      }),
    ).toMatchObject({ outcome: "needs_approval" });

    expect(
      decidePermission("DESTRUCTIVE", [], {
        toolName: "files.delete",
        autonomous: { enabled: true, trustedTools: ["files.delete"] },
      }),
    ).toEqual({ outcome: "allowed", autonomous: true });

    // Off by default: an agent that was never made autonomous still asks.
    expect(
      decidePermission("DESTRUCTIVE", [], {
        toolName: "files.delete",
        autonomous: { enabled: false, trustedTools: ["files.delete"] },
      }),
    ).toMatchObject({ outcome: "needs_approval" });
  });
});
