import { ProviderError } from "@aiw/ai";
import {
  getMessageForTask,
  getTask,
  listAgentsForUser,
  listTaskEvents,
  listTaskSteps,
  updateAgentForUser,
  type DatabaseHandle,
} from "@aiw/database";
import type { TaskEvent } from "@aiw/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentRuntime,
  createTaskEventStream,
  ensureBuiltinAgents,
  InMemoryTaskEventBus,
  InProcessTaskExecutor,
  TaskService,
  type TaskBusMessage,
} from "../src";
import { createUser, eventRecorder, openTestDatabase, registryFor, ScriptedProvider, waitOrAbort, type Handler } from "./helpers";

let handle: DatabaseHandle;
beforeAll(() => {
  handle = openTestDatabase();
});
afterAll(async () => {
  await handle.close();
});

async function setup(handler: Handler, planningMode: "auto" | "never" = "auto") {
  const provider = new ScriptedProvider(handler);
  const registry = registryFor(provider);
  const { bus, events } = eventRecorder(handle);
  const runtime = new AgentRuntime({ db: handle.db, registry, events, retryDelaysMs: [5] });
  const executor = new InProcessTaskExecutor(runtime);
  const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: 3 });
  const userId = await createUser(handle);
  await ensureBuiltinAgents(handle.db, userId);
  for (const agent of await listAgentsForUser(handle.db, userId)) {
    await updateAgentForUser(handle.db, userId, agent.id, { provider: "scripted", planningMode });
  }
  const general = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "general")!;
  const messages: TaskBusMessage[] = [];
  return { provider, bus, events, executor, service, userId, general, messages };
}

function record(bus: InMemoryTaskEventBus, taskId: string, into: TaskBusMessage[]) {
  return bus.subscribe(taskId, (message) => into.push(message));
}

const types = async (taskId: string) => (await listTaskEvents(handle.db, taskId)).map((e) => e.type);

const twoStepPlan: Handler = (request, kind) => {
  if (kind === "planning") return JSON.stringify({ steps: [{ title: "Gather", instruction: "1" }, { title: "Analyse", instruction: "2" }] });
  const prompt = request.messages.at(-1)?.content ?? "";
  if (prompt.includes("Current step (1 of 3)")) return "gathered";
  if (prompt.includes("Current step (2 of 3)")) return "analysed";
  return "final answer";
};

describe("InMemoryTaskEventBus", () => {
  it("delivers messages per task, isolates failing listeners and unsubscribes", () => {
    const bus = new InMemoryTaskEventBus();
    const received: string[] = [];
    const originalError = console.error;
    console.error = () => {};
    bus.subscribe("t1", () => {
      throw new Error("bad listener");
    });
    const off = bus.subscribe("t1", (m) => received.push(m.kind));
    bus.subscribe("t2", () => received.push("wrong task"));

    bus.publish({ kind: "delta", delta: { taskId: "t1", stepId: "s", text: "x" } });
    off();
    bus.publish({ kind: "delta", delta: { taskId: "t1", stepId: "s", text: "y" } });
    console.error = originalError;

    expect(received).toEqual(["delta"]);
    expect(bus.listenerCount("t1")).toBe(1);
  });
});

describe("runtime events", () => {
  it("emits the full typed timeline in order and streams step output", async () => {
    const { service, executor, bus, userId, general, messages } = await setup(twoStepPlan);
    const created = await service.createTask(userId, { prompt: "Analyse something", agentId: general.id });
    record(bus, created.task.id, messages);
    expect(await executor.waitFor(created.task.id)).toBe("completed");

    expect(await types(created.task.id)).toEqual([
      "TASK_CREATED",
      "AGENT_SELECTED",
      "AGENT_STARTED",
      "THINKING_STATUS",
      "MODEL_CALL_FINISHED",
      "PLAN_CREATED",
      "TASK_PROGRESS",
      ...Array.from({ length: 3 }, () => ["STEP_STARTED", "THINKING_STATUS", "MODEL_CALL_FINISHED", "STEP_COMPLETED", "TASK_PROGRESS"]).flat(),
      // The final answer is placed on the timeline in the agent's own words (spec §5).
      "AGENT_MESSAGE",
      "TASK_COMPLETED",
    ]);

    const events = (await listTaskEvents(handle.db, created.task.id)).map((e) => e);
    const plan = events.find((e) => e.type === "PLAN_CREATED")!;
    expect((plan.data as { steps: unknown[] }).steps).toHaveLength(3);
    expect(events.find((e) => e.type === "AGENT_STARTED")).toMatchObject({ agentName: "General Agent", status: "running" });
    const lastProgress = events.filter((e) => e.type === "TASK_PROGRESS").at(-1)!;
    expect(lastProgress.data).toEqual({ completed: 3, total: 3, percent: 100 });
    const completed = events.find((e) => e.type === "STEP_COMPLETED")!;
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.stepId).not.toBeNull();
    expect(events.find((e) => e.type === "MODEL_CALL_FINISHED")?.data).toMatchObject({
      purpose: "planning",
      status: "completed",
      inputTokens: 10,
      attempt: 1,
    });

    // Output for each step streamed as deltas, tied to the step.
    const steps = await listTaskSteps(handle.db, created.task.id);
    const deltas = messages.flatMap((m) => (m.kind === "delta" ? [m.delta] : []));
    expect(deltas.map((d) => [d.stepId, d.text])).toEqual(steps.map((s) => [s.id, s.output]));
  });

  it("records failures, retry notices and step failure events", async () => {
    let calls = 0;
    const { service, executor, bus, userId, general, messages } = await setup(() => {
      calls++;
      throw new ProviderError("rate_limited", "Gemini rate limit or quota exceeded. Try again shortly.", { provider: "scripted", status: 429 });
    }, "never");
    const created = await service.createTask(userId, { prompt: "x", agentId: general.id });
    record(bus, created.task.id, messages);
    expect(await executor.waitFor(created.task.id)).toBe("failed");
    expect(calls).toBe(2);

    const events = await listTaskEvents(handle.db, created.task.id);
    const warning = events.find((e) => e.type === "THINKING_STATUS" && e.status === "warning");
    expect(warning?.description).toContain("rate limiting requests. Retrying in 0 s (attempt 2 of 2)");
    expect(events.filter((e) => e.type === "MODEL_CALL_FINISHED").map((e) => (e.data as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(events.find((e) => e.type === "STEP_FAILED")).toMatchObject({ status: "error" });
    expect(events.at(-1)).toMatchObject({ type: "TASK_FAILED", status: "error" });
    expect((events.at(-1)!.data as { error: { code: string } }).error.code).toBe("provider_rate_limited");
    expect(messages.some((m) => m.kind === "delta" && m.delta.reset)).toBe(true);
  });
});

describe("pause and resume", () => {
  it("pauses after the current step and resumes without repeating work", async () => {
    let releaseStepOne!: () => void;
    const stepOneGate = new Promise<void>((resolve) => (releaseStepOne = resolve));
    const { service, executor, provider, userId, general } = await setup(async (request, kind) => {
      if (kind === "planning") return twoStepPlan(request, kind);
      const prompt = request.messages.at(-1)?.content ?? "";
      if (prompt.includes("Current step (1 of 3)")) await stepOneGate;
      return twoStepPlan(request, kind);
    });
    const created = await service.createTask(userId, { prompt: "Pause me", agentId: general.id });

    // Wait until step one is running, then ask to pause.
    for (let i = 0; i < 100 && (await listTaskSteps(handle.db, created.task.id)).every((s) => s.status !== "running"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const requested = await service.pauseTask(userId, created.task.id);
    expect(requested.pauseRequestedAt).not.toBeNull();
    releaseStepOne();

    expect(await executor.waitFor(created.task.id)).toBe("paused");
    const paused = (await getTask(handle.db, created.task.id))!;
    expect(paused).toMatchObject({ status: "paused", pauseRequestedAt: null });
    expect((await listTaskSteps(handle.db, created.task.id)).map((s) => s.status)).toEqual(["completed", "pending", "pending"]);
    expect(await getMessageForTask(handle.db, created.task.id)).toMatchObject({ status: "streaming" });
    await expect(service.pauseTask(userId, created.task.id)).rejects.toMatchObject({ status: 409 });

    const stepCallsBefore = provider.calls("step").length;
    await service.resumeTask(userId, created.task.id);
    expect(await executor.waitFor(created.task.id)).toBe("completed");
    expect(provider.calls("step").length - stepCallsBefore).toBe(2);
    expect((await getTask(handle.db, created.task.id))?.result).toBe("final answer");

    const timeline = await types(created.task.id);
    for (const expected of ["TASK_PAUSE_REQUESTED", "TASK_PAUSED", "TASK_RESUMED", "TASK_COMPLETED"]) {
      expect(timeline).toContain(expected);
    }
    expect(timeline.indexOf("TASK_PAUSED")).toBeLessThan(timeline.indexOf("TASK_RESUMED"));
    await expect(service.resumeTask(userId, created.task.id)).rejects.toMatchObject({ status: 409 });
  });

  it("stops a paused task directly", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, executor, userId, general } = await setup(async (request, kind) => {
      if (kind === "step" && request.messages.at(-1)?.content.includes("Current step (1 of 3)")) await gate;
      return twoStepPlan(request, kind);
    });
    const created = await service.createTask(userId, { prompt: "Stop while paused", agentId: general.id });
    for (let i = 0; i < 100 && (await listTaskSteps(handle.db, created.task.id)).every((s) => s.status !== "running"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await service.pauseTask(userId, created.task.id);
    release();
    expect(await executor.waitFor(created.task.id)).toBe("paused");

    const stopped = await service.stopTask(userId, created.task.id);
    expect(stopped.status).toBe("cancelled");
    expect(await getMessageForTask(handle.db, created.task.id)).toMatchObject({ status: "cancelled" });
    expect((await types(created.task.id)).at(-1)).toBe("TASK_CANCELLED");
  });
});

async function readFrames(stream: ReadableStream<Uint8Array>, until: (frames: SseFrame[]) => boolean, timeoutMs = 5000) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!until(frames)) {
    const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
    );
    const { done, value } = await Promise.race([reader.read(), timeout]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      frames.push(parseFrame(buffer.slice(0, index)));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

interface SseFrame {
  id?: number;
  event?: string;
  data?: unknown;
  comment?: string;
}

function parseFrame(raw: string): SseFrame {
  const out: SseFrame = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith(": ")) out.comment = line.slice(2);
    else if (line.startsWith("id: ")) out.id = Number(line.slice(4));
    else if (line.startsWith("event: ")) out.event = line.slice(7);
    else if (line.startsWith("data: ")) out.data = JSON.parse(line.slice(6));
  }
  return out;
}

describe("createTaskEventStream", () => {
  it("replays history for a finished task and ends", async () => {
    const { service, executor, bus, userId, general } = await setup(twoStepPlan);
    const created = await service.createTask(userId, { prompt: "Replay", agentId: general.id });
    await executor.waitFor(created.task.id);
    const stored = await listTaskEvents(handle.db, created.task.id);

    const frames = await readFrames(
      createTaskEventStream({ db: handle.db, bus, taskId: created.task.id, afterId: 0 }),
      (f) => f.some((x) => x.event === "end"),
    );
    const taskFrames = frames.filter((f) => f.event === "task");
    expect(taskFrames.map((f) => f.id)).toEqual(stored.map((e) => e.id));
    expect(frames.at(-1)?.event).toBe("end");

    // Resuming after an id only sends newer events.
    const resumeFrom = stored[stored.length - 3]!.id;
    const resumed = await readFrames(
      createTaskEventStream({ db: handle.db, bus, taskId: created.task.id, afterId: resumeFrom }),
      (f) => f.some((x) => x.event === "end"),
    );
    expect(resumed.filter((f) => f.event === "task").map((f) => f.id)).toEqual(stored.slice(-2).map((e) => e.id));
  });

  it("streams live events and deltas without duplicates, then ends on completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, executor, bus, userId, general } = await setup(async (request, kind) => {
      if (kind === "step") await gate;
      return twoStepPlan(request, kind);
    }, "never");
    const created = await service.createTask(userId, { prompt: "Live", agentId: general.id });

    const stream = createTaskEventStream({ db: handle.db, bus, taskId: created.task.id, afterId: 0, heartbeatMs: 20 });
    const reading = readFrames(stream, (f) => f.some((x) => x.event === "end"), 8000);
    await new Promise((r) => setTimeout(r, 100));
    release();
    await executor.waitFor(created.task.id);
    const frames = await reading;

    const ids = frames.filter((f) => f.event === "task").map((f) => f.id!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const stored = await listTaskEvents(handle.db, created.task.id);
    expect(ids).toEqual(stored.map((e) => e.id));
    expect(frames.some((f) => f.event === "delta" && (f.data as { text: string }).text === "final answer")).toBe(true);
    expect(frames.some((f) => f.comment === "ping")).toBe(true);
    expect((frames.filter((f) => f.event === "task").at(-1)?.data as TaskEvent).type).toBe("TASK_COMPLETED");
    expect(bus.listenerCount(created.task.id)).toBe(0);
  });
});

describe("AGENT_MESSAGE headline", () => {
  it("puts a one-line, markdown-free headline in the description and the text in data", async () => {
    const long = `## Result\n\nTo build your **SaaS** effectively, stop asking for _ideas_ and start asking for architectures. ${"More detail. ".repeat(80)}`;
    const { service, executor, userId, general } = await setup(() => long, "never");
    const created = await service.createTask(userId, { prompt: "Long answer", agentId: general.id });
    expect(await executor.waitFor(created.task.id)).toBe("completed");

    const event = (await listTaskEvents(handle.db, created.task.id)).find((e) => e.type === "AGENT_MESSAGE")!;
    expect(event.description).toBe("Result");
    expect(event.description.length).toBeLessThanOrEqual(160);
    expect(event.description).not.toMatch(/[*_#]/);
    expect((event.data as { text: string }).text.startsWith("## Result")).toBe(true);
  });
});
