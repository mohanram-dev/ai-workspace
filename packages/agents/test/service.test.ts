import { randomUUID } from "node:crypto";
import {
  getMessageForTask,
  getTask,
  insertMessage,
  listAgentsForUser,
  listMessages,
  listTaskSteps,
  schema,
  updateAgentForUser,
  type DatabaseHandle,
} from "@aiw/database";
import { AppError } from "@aiw/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime, BUILTIN_AGENTS, ensureBuiltinAgents, InProcessTaskExecutor, TaskService } from "../src";
import { createUser, eventRecorder, openTestDatabase, registryFor, ScriptedProvider, waitOrAbort, type Handler } from "./helpers";

let handle: DatabaseHandle;
beforeAll(() => {
  handle = openTestDatabase();
});
afterAll(async () => {
  await handle.close();
});

async function setup(handler: Handler, options: { maxRunning?: number } = {}) {
  const provider = new ScriptedProvider(handler);
  const registry = registryFor(provider);
  const { bus, events } = eventRecorder(handle);
  const runtime = new AgentRuntime({ db: handle.db, registry, events, retryDelaysMs: [] });
  const executor = new InProcessTaskExecutor(runtime);
  const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: options.maxRunning ?? 3 });
  const userId = await createUser(handle);
  await ensureBuiltinAgents(handle.db, userId);
  for (const agent of await listAgentsForUser(handle.db, userId)) {
    await updateAgentForUser(handle.db, userId, agent.id, { provider: "scripted", planningMode: "never" });
  }
  const agents = await listAgentsForUser(handle.db, userId);
  return { provider, executor, service, userId, agents, bus, events, general: agents.find((a) => a.slug === "general")! };
}

describe("ensureBuiltinAgents", () => {
  it("is idempotent and keeps user edits", async () => {
    const userId = await createUser(handle);
    await ensureBuiltinAgents(handle.db, userId);
    const [first] = await listAgentsForUser(handle.db, userId);
    await updateAgentForUser(handle.db, userId, first!.id, { name: "Renamed" });
    await ensureBuiltinAgents(handle.db, userId);

    const agents = await listAgentsForUser(handle.db, userId);
    expect(agents).toHaveLength(BUILTIN_AGENTS.length);
    expect(agents.find((a) => a.id === first!.id)?.name).toBe("Renamed");
  });
});

describe("TaskService", () => {
  it("creates a conversation, messages and runs the task in the background", async () => {
    const { service, executor, userId, general } = await setup(() => "Hello from the agent");
    const created = await service.createTask(userId, { prompt: "Say hello", agentId: general.id });

    expect(created.conversation.title).toBe("Say hello");
    expect(created.userMessage).toMatchObject({ role: "user", content: "Say hello" });
    expect(created.assistantMessage).toMatchObject({ role: "assistant", status: "streaming", taskId: created.task.id });
    expect(created.task.agent?.slug).toBe("general");

    expect(await executor.waitFor(created.task.id)).toBe("completed");
    expect(await getMessageForTask(handle.db, created.task.id)).toMatchObject({
      status: "completed",
      content: "Hello from the agent",
    });
  });

  it("rejects a second task while the conversation is busy", async () => {
    const { service, executor, userId, general } = await setup(async (request) => {
      await waitOrAbort(200, request.signal);
      return "slow";
    });
    const first = await service.createTask(userId, { prompt: "One", agentId: general.id });
    const error = await service
      .createTask(userId, { prompt: "Two", agentId: general.id, conversationId: first.conversation.id })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409 });
    await executor.waitFor(first.task.id);
  });

  it("limits running tasks per user", async () => {
    const { service, executor, userId, general } = await setup(async (request) => {
      await waitOrAbort(200, request.signal);
      return "slow";
    }, { maxRunning: 1 });
    const first = await service.createTask(userId, { prompt: "One", agentId: general.id });
    await expect(service.createTask(userId, { prompt: "Two", agentId: general.id })).rejects.toMatchObject({ status: 429 });
    await executor.waitFor(first.task.id);
  });

  it("refuses other users' agents, conversations and tasks", async () => {
    const owner = await setup(() => "x");
    const intruder = await setup(() => "x");
    const created = await owner.service.createTask(owner.userId, { prompt: "Private", agentId: owner.general.id });
    await owner.executor.waitFor(created.task.id);

    await expect(intruder.service.createTask(intruder.userId, { prompt: "x", agentId: owner.general.id })).rejects.toMatchObject({ status: 404 });
    await expect(
      intruder.service.createTask(intruder.userId, { prompt: "x", conversationId: created.conversation.id }),
    ).rejects.toMatchObject({ status: 404 });
    for (const action of ["stopTask", "retryTask", "continueTask"] as const) {
      await expect(intruder.service[action](intruder.userId, created.task.id)).rejects.toMatchObject({ status: 404 });
    }
  });

  it("rejects unknown override models before creating anything", async () => {
    const { service, userId } = await setup(() => "x");
    await expect(service.createTask(userId, { prompt: "x", model: "not-a-model" })).rejects.toMatchObject({
      code: "model_not_found",
    });
    const tasks = await handle.db.select().from(schema.tasks).where(eq(schema.tasks.userId, userId));
    expect(tasks).toEqual([]);
  });

  it("stops a running task", async () => {
    const { service, executor, userId, general } = await setup(async (request) => {
      await waitOrAbort(5000, request.signal);
      return "never";
    });
    const created = await service.createTask(userId, { prompt: "Long job", agentId: general.id });
    await new Promise((r) => setTimeout(r, 50));
    await service.stopTask(userId, created.task.id);
    expect(await executor.waitFor(created.task.id)).toBe("cancelled");
    await expect(service.stopTask(userId, created.task.id)).rejects.toMatchObject({ status: 409 });
  });

  it("stops an orphaned task that no executor is running", async () => {
    const { service, userId, general } = await setup(() => "x");
    const created = await service.createTask(userId, { prompt: "x", agentId: general.id });
    const executorless = new TaskService({
      db: handle.db,
      registry: registryFor(new ScriptedProvider(() => "x")),
      executor: { start: () => {}, stop: async () => false },
      events: eventRecorder(handle).events,
      maxRunningTasksPerUser: 3,
    });
    // Simulate a task stuck mid-run in another process.
    await handle.db.update(schema.tasks).set({ status: "running" }).where(eq(schema.tasks.id, created.task.id));
    const stopped = await executorless.stopTask(userId, created.task.id);
    expect(stopped.status).toBe("cancelled");
  });

  it("continues a failed task and retries a finished one as a new task", async () => {
    let fail = true;
    const { service, executor, userId, general, provider } = await setup(() => {
      if (fail) throw new Error("boom");
      return "recovered";
    });
    const originalError = console.error;
    console.error = () => {};
    const created = await service.createTask(userId, { prompt: "Flaky", agentId: general.id });
    expect(await executor.waitFor(created.task.id)).toBe("failed");
    console.error = originalError;
    expect((await getTask(handle.db, created.task.id))?.error?.code).toBe("internal");

    await expect(service.retryTask(userId, randomUUID())).rejects.toMatchObject({ status: 404 });

    fail = false;
    const continued = await service.continueTask(userId, created.task.id);
    expect(continued.attempt).toBe(2);
    expect(await executor.waitFor(created.task.id)).toBe("completed");

    // "Ask agent to fix" (spec §40): the retried step is told what went wrong
    // last time, rather than being asked blind.
    const retryPrompt = provider.calls("step").at(-1)!.request.messages.at(-1)!;
    expect(retryPrompt.role).toBe("user");
    expect(retryPrompt.content).toContain("Previous attempt failed");
    expect(retryPrompt.content).toContain("You are being asked to fix this");
    expect(await getMessageForTask(handle.db, created.task.id)).toMatchObject({ content: "recovered" });
    await expect(service.continueTask(userId, created.task.id)).rejects.toMatchObject({ status: 409 });

    const callsBefore = provider.requests.length;
    const retried = await service.retryTask(userId, created.task.id);
    expect(retried).toMatchObject({ retryOfTaskId: created.task.id, attempt: 3, prompt: "Flaky" });
    expect(await executor.waitFor(retried.id)).toBe("completed");
    expect(provider.requests.length).toBeGreaterThan(callsBefore);

    // The conversation reply now belongs to the retry; history is preserved.
    const messages = await listMessages(handle.db, created.conversation.id);
    expect(messages.map((m) => m.taskId)).toEqual([null, retried.id]);
    expect((await listTaskSteps(handle.db, created.task.id)).length).toBeGreaterThan(0);
  });

  it("allows a task when the last message is an old interrupted chat stream", async () => {
    const { service, executor, userId, general } = await setup(() => "fine");
    const created = await service.createTask(userId, { prompt: "First", agentId: general.id });
    await executor.waitFor(created.task.id);
    await insertMessage(handle.db, {
      conversationId: created.conversation.id,
      role: "assistant",
      status: "streaming",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const next = await service.createTask(userId, {
      prompt: "Second",
      agentId: general.id,
      conversationId: created.conversation.id,
    });
    expect(await executor.waitFor(next.task.id)).toBe("completed");
  });
});
