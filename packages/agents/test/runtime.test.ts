import { ProviderError } from "@aiw/ai";
import {
  createConversation,
  createTask,
  getAgentForUser,
  getMessageForTask,
  getTask,
  insertMessage,
  listAgentsForUser,
  listTaskSteps,
  resetUnfinishedSteps,
  schema,
  updateAgentForUser,
  type Agent,
  type DatabaseHandle,
} from "@aiw/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime, ensureBuiltinAgents, recoverInterruptedTasks, SYNTHESIS_STEP } from "../src";
import { createUser, eventRecorder, openTestDatabase, registryFor, ScriptedProvider, waitOrAbort, type Handler } from "./helpers";

let handle: DatabaseHandle;
beforeAll(() => {
  handle = openTestDatabase();
});
afterAll(async () => {
  await handle.close();
});

async function setup(handler: Handler, agentChanges: Partial<Agent> = {}, slug = "general") {
  const provider = new ScriptedProvider(handler);
  const { bus, events } = eventRecorder(handle);
  const runtime = new AgentRuntime({ db: handle.db, registry: registryFor(provider), events, retryDelaysMs: [5, 5] });
  const userId = await createUser(handle);
  await ensureBuiltinAgents(handle.db, userId);
  let agent = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === slug)!;
  // Test agents use the scripted provider.
  agent = (await updateAgentForUser(handle.db, userId, agent.id, { provider: "scripted", ...agentChanges }))!;
  return { provider, runtime, userId, agent, bus, events };
}

async function queueTask(userId: string, options: { agentId?: string | null; prompt?: string } = {}) {
  const conversation = await createConversation(handle.db, { userId, title: "t" });
  const task = await createTask(handle.db, {
    userId,
    agentId: options.agentId ?? null,
    conversationId: conversation.id,
    prompt: options.prompt ?? "Explain containers",
  });
  await insertMessage(handle.db, { conversationId: conversation.id, role: "user", content: task.prompt });
  await insertMessage(handle.db, {
    conversationId: conversation.id,
    taskId: task.id,
    role: "assistant",
    status: "streaming",
  });
  return { task, conversation };
}

const usageFor = (taskId: string) =>
  handle.db.select().from(schema.usageLogs).where(eq(schema.usageLogs.taskId, taskId));

describe("AgentRuntime", () => {
  it("runs a manually selected agent with a single planned step", async () => {
    const { runtime, userId, agent, provider } = await setup((_r, kind) =>
      kind === "planning" ? JSON.stringify({ steps: [{ title: "Explain", instruction: "Explain briefly." }] }) : "Containers package apps.",
    );
    const { task } = await queueTask(userId, { agentId: agent.id });

    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("completed");

    const done = (await getTask(handle.db, task.id))!;
    expect(done).toMatchObject({
      status: "completed",
      result: "Containers package apps.",
      provider: "scripted",
      model: "scripted-1",
      routing: { mode: "manual", method: "manual" },
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(done.durationMs).toBeGreaterThanOrEqual(0);

    const steps = await listTaskSteps(handle.db, task.id);
    expect(steps.map((s) => [s.title, s.status])).toEqual([["Explain", "completed"]]);

    const message = await getMessageForTask(handle.db, task.id);
    expect(message).toMatchObject({ status: "completed", content: "Containers package apps.", inputTokens: 20 });

    const usage = await usageFor(task.id);
    expect(usage.map((u) => u.purpose).sort()).toEqual(["planning", "step"]);
    expect(usage.every((u) => u.agentId === agent.id)).toBe(true);

    // The agent's instructions and the no-tools notice reach the model.
    const system = provider.calls("step")[0]?.request.system ?? "";
    expect(system).toContain(agent.instructions);
    expect(system).toContain("You currently have NO tools");
  });

  it("routes automatically and records the decision", async () => {
    const { runtime, userId } = await setup((_r, kind) => {
      if (kind === "routing") return JSON.stringify({ agent: "devops", reason: "Server diagnostics.", confidence: 0.8 });
      if (kind === "planning") return JSON.stringify({ steps: [{ title: "Diagnose", instruction: "Diagnose." }] });
      return "Run docker system df.";
    });
    // Built-in agents other than general still point at gemini; move them to the scripted provider.
    for (const a of await listAgentsForUser(handle.db, userId)) {
      await updateAgentForUser(handle.db, userId, a.id, { provider: "scripted" });
    }
    const { task } = await queueTask(userId, { prompt: "Docker uses too much disk" });

    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("completed");
    const done = (await getTask(handle.db, task.id))!;
    const devops = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "devops")!;
    expect(done.agentId).toBe(devops.id);
    expect(done.routing).toEqual({ mode: "auto", method: "llm", reason: "Server diagnostics.", confidence: 0.8 });
    expect((await usageFor(task.id)).some((u) => u.purpose === "routing" && u.agentId === null)).toBe(true);
  });

  it("executes multi-step plans in order and composes the final response", async () => {
    const { runtime, userId, agent, provider } = await setup((request, kind) => {
      if (kind === "planning") {
        return JSON.stringify({
          steps: [
            { title: "List frameworks", instruction: "List them." },
            { title: "Compare", instruction: "Compare them." },
          ],
        });
      }
      const prompt = request.messages.at(-1)?.content ?? "";
      if (prompt.includes("Current step (1 of 3)")) return "A, B, C";
      if (prompt.includes("Current step (2 of 3)")) return "A is fastest";
      return "Final report: A wins";
    });
    const { task } = await queueTask(userId, { agentId: agent.id });

    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("completed");
    const steps = await listTaskSteps(handle.db, task.id);
    expect(steps.map((s) => [s.title, s.status, s.output])).toEqual([
      ["List frameworks", "completed", "A, B, C"],
      ["Compare", "completed", "A is fastest"],
      [SYNTHESIS_STEP.title, "completed", "Final report: A wins"],
    ]);
    // Later steps see earlier outputs.
    const synthesisPrompt = provider.calls("step")[2]?.request.messages.at(-1)?.content ?? "";
    expect(synthesisPrompt).toContain("A, B, C");
    expect(synthesisPrompt).toContain("A is fastest");
    expect((await getTask(handle.db, task.id))?.result).toBe("Final report: A wins");
  });

  it("includes prior conversation turns but not the task's own prompt", async () => {
    const { runtime, userId, agent, provider } = await setup(() => "ok", { planningMode: "never" });
    const conversation = await createConversation(handle.db, { userId, title: "t" });
    await insertMessage(handle.db, { conversationId: conversation.id, role: "user", content: "Earlier question" });
    await insertMessage(handle.db, { conversationId: conversation.id, role: "assistant", content: "Earlier answer" });
    const task = await createTask(handle.db, { userId, agentId: agent.id, conversationId: conversation.id, prompt: "Now this" });
    await insertMessage(handle.db, { conversationId: conversation.id, role: "user", content: "Now this" });
    await insertMessage(handle.db, { conversationId: conversation.id, taskId: task.id, role: "assistant", status: "streaming" });

    await runtime.execute(task.id, new AbortController().signal);
    const messages = provider.calls("step")[0]!.request.messages;
    expect(messages.slice(0, 2)).toEqual([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[2]?.content).toContain("Now this");
  });

  it("reports a failed step with a readable error and keeps completed work", async () => {
    let failStepTwo = true;
    const { runtime, userId, agent, provider } = await setup((request, kind) => {
      if (kind === "planning") {
        return JSON.stringify({ steps: [{ title: "One", instruction: "1" }, { title: "Two", instruction: "2" }] });
      }
      const prompt = request.messages.at(-1)?.content ?? "";
      if (prompt.includes("Current step (2 of 3)") && failStepTwo) {
        throw new ProviderError("rate_limited", "Gemini rate limit or quota exceeded. Try again shortly.", {
          provider: "scripted",
          status: 429,
        });
      }
      return prompt.includes("Current step (1 of 3)") ? "one done" : "final";
    });
    const { task } = await queueTask(userId, { agentId: agent.id });

    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("failed");
    const failed = (await getTask(handle.db, task.id))!;
    expect(failed.error).toMatchObject({
      code: "provider_rate_limited",
      title: "Model request failed",
      stepIndex: 1,
      stepTitle: "Two",
      retryable: true,
      detail: "scripted error: rate_limited (HTTP 429)",
    });
    expect(failed.error?.suggestedAction).toContain("Wait");
    expect((await listTaskSteps(handle.db, task.id)).map((s) => s.status)).toEqual(["completed", "failed", "pending"]);
    expect(await getMessageForTask(handle.db, task.id)).toMatchObject({ status: "failed" });

    // Continue: re-queue and run again; step one is not repeated.
    failStepTwo = false;
    const stepOneCalls = () => provider.calls("step").filter((c) => c.request.messages.at(-1)?.content.includes("Current step (1 of 3)")).length;
    const before = stepOneCalls();
    await resetUnfinishedSteps(handle.db, task.id);
    await handle.db.update(schema.tasks).set({ status: "queued" }).where(eq(schema.tasks.id, task.id));
    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("completed");
    expect(stepOneCalls()).toBe(before);
    expect((await getTask(handle.db, task.id))?.result).toBe("final");
  });

  it("retries rate-limited calls automatically and records each attempt", async () => {
    let failures = 2;
    const { runtime, userId, agent } = await setup(() => {
      if (failures-- > 0) {
        throw new ProviderError("rate_limited", "Gemini rate limit or quota exceeded. Try again shortly.", {
          provider: "scripted",
          status: 429,
        });
      }
      return "worked after retries";
    }, { planningMode: "never" });
    const { task } = await queueTask(userId, { agentId: agent.id });

    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("completed");
    expect((await getTask(handle.db, task.id))?.result).toBe("worked after retries");
    const usage = await usageFor(task.id);
    expect(usage.map((u) => u.status).sort()).toEqual(["completed", "failed", "failed"]);
  });

  it("gives up after the retry budget and does not retry permanent errors", async () => {
    let calls = 0;
    const { runtime, userId, agent } = await setup(() => {
      calls++;
      throw new ProviderError("authentication", "Gemini rejected the API key. Check GEMINI_API_KEY.", { provider: "scripted" });
    }, { planningMode: "never" });
    const { task } = await queueTask(userId, { agentId: agent.id });
    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("failed");
    expect(calls).toBe(1);
    expect((await getTask(handle.db, task.id))?.error?.code).toBe("provider_authentication");
  });

  it("reports a time limit reached between steps as a timeout, not a cancellation", async () => {
    const { runtime, userId, agent } = await setup(async (request, kind) => {
      if (kind === "planning") {
        return JSON.stringify({ steps: [{ title: "Slow one", instruction: "1" }, { title: "Two", instruction: "2" }] });
      }
      // Finishes just after the limit without observing the abort signal.
      await new Promise((r) => setTimeout(r, 1100));
      return request.messages.length ? "done" : "done";
    }, { maxExecutionSeconds: 1 });
    const { task } = await queueTask(userId, { agentId: agent.id });

    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("failed");
    expect((await getTask(handle.db, task.id))?.error?.code).toBe("timeout");
  });

  it("cancels a running step when the signal aborts", async () => {
    const controller = new AbortController();
    const { runtime, userId, agent } = await setup(async (request) => {
      setTimeout(() => controller.abort(), 20);
      await waitOrAbort(5000, request.signal);
      return "never";
    }, { planningMode: "never" });
    const { task } = await queueTask(userId, { agentId: agent.id });

    expect(await runtime.execute(task.id, controller.signal)).toBe("cancelled");
    expect(await getTask(handle.db, task.id)).toMatchObject({ status: "cancelled", error: null });
    expect((await listTaskSteps(handle.db, task.id))[0]?.status).toBe("cancelled");
    expect(await getMessageForTask(handle.db, task.id)).toMatchObject({ status: "cancelled" });
  });

  it("fails with a timeout when the agent's time limit is exceeded", async () => {
    const { runtime, userId, agent } = await setup(async (request) => {
      await waitOrAbort(5000, request.signal);
      return "never";
    }, { planningMode: "never", maxExecutionSeconds: 1 });
    const { task } = await queueTask(userId, { agentId: agent.id });

    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("failed");
    expect((await getTask(handle.db, task.id))?.error).toMatchObject({
      code: "timeout",
      message: "The task exceeded the agent's 1-second limit.",
      stepIndex: 0,
    });
  });

  it("stops before calling the model when the daily budget is used up", async () => {
    const { runtime, userId, agent, provider } = await setup(() => "x", { dailyBudgetUsd: 0 });
    const { task } = await queueTask(userId, { agentId: agent.id });

    expect(await runtime.execute(task.id, new AbortController().signal)).toBe("failed");
    expect((await getTask(handle.db, task.id))?.error).toMatchObject({ code: "budget_exceeded", retryable: true });
    expect(provider.requests).toHaveLength(0);
  });

  it("fails clearly for disabled agents and empty responses", async () => {
    const disabled = await setup(() => "x", { enabled: false });
    const { task } = await queueTask(disabled.userId, { agentId: disabled.agent.id });
    await disabled.runtime.execute(task.id, new AbortController().signal);
    expect((await getTask(handle.db, task.id))?.error?.code).toBe("agent_unavailable");

    const empty = await setup(() => "   ", { planningMode: "never" });
    const second = await queueTask(empty.userId, { agentId: empty.agent.id });
    await empty.runtime.execute(second.task.id, new AbortController().signal);
    expect((await getTask(handle.db, second.task.id))?.error).toMatchObject({ code: "empty_response", stepIndex: 0 });
  });

  it("never runs the same task twice concurrently", async () => {
    const { runtime, userId, agent, provider } = await setup(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return "done";
    }, { planningMode: "never" });
    const { task } = await queueTask(userId, { agentId: agent.id });

    const results = await Promise.all([
      runtime.execute(task.id, new AbortController().signal),
      runtime.execute(task.id, new AbortController().signal),
    ]);
    expect(results.sort()).toEqual(["completed", null].sort());
    expect(provider.calls("step")).toHaveLength(1);
  });

  it("marks tasks left running by a previous process as interrupted", async () => {
    const { userId, agent } = await setup(() => "x");
    const { task } = await queueTask(userId, { agentId: agent.id });
    await handle.db.update(schema.tasks).set({ status: "running" }).where(eq(schema.tasks.id, task.id));

    const recovered = await recoverInterruptedTasks(handle.db, eventRecorder(handle).events);
    expect(recovered).toContain(task.id);
    expect((await getTask(handle.db, task.id))?.error).toMatchObject({ code: "interrupted", retryable: true });
    expect(await getMessageForTask(handle.db, task.id)).toMatchObject({ status: "failed" });
    expect(await getAgentForUser(handle.db, userId, agent.id)).not.toBeNull();
  });
});
