import { ProviderError } from "@aiw/ai";
import { getTask, listAgentsForUser, listTaskEvents, updateAgentForUser, type DatabaseHandle } from "@aiw/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime, ensureBuiltinAgents, InProcessTaskExecutor, TaskService } from "../src";
import { createUser, eventRecorder, openTestDatabase, registryFor, ScriptedProvider, type Handler } from "./helpers";

let handle: DatabaseHandle;
beforeAll(() => {
  handle = openTestDatabase();
});
afterAll(async () => {
  await handle.close();
});

/**
 * `modelFallbacks` moves a call to another model when the chosen one cannot
 * answer (spec §13). The provider here is scripted to fail on `scripted-1` in
 * whatever way each test needs, and to answer on `scripted-2`.
 */
async function setup(failFirstWith: unknown, fallbacks = ["scripted-2"]) {
  const seen: string[] = [];
  const handler: Handler = (request, kind) => {
    seen.push(request.model);
    if (request.model === "scripted-1") throw failFirstWith;
    if (kind === "planning") return JSON.stringify({ steps: [{ title: "Do it", instruction: "go" }] });
    return "answered by the fallback";
  };
  const provider = new ScriptedProvider(handler);
  const registry = registryFor(provider);
  const { events } = eventRecorder(handle);
  const runtime = new AgentRuntime({ db: handle.db, registry, events, retryDelaysMs: [], modelFallbacks: fallbacks });
  const executor = new InProcessTaskExecutor(runtime);
  const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: 3 });
  const userId = await createUser(handle);
  await ensureBuiltinAgents(handle.db, userId);
  for (const agent of await listAgentsForUser(handle.db, userId)) {
    await updateAgentForUser(handle.db, userId, agent.id, { provider: "scripted", planningMode: "auto" });
  }
  const general = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "general")!;
  return { service, executor, userId, general, seen };
}

describe("model fallback (spec §13)", () => {
  it("moves to the next model when the chosen one is rate limited", async () => {
    const { service, executor, userId, general, seen } = await setup(
      new ProviderError("rate_limited", "Out of quota.", { provider: "scripted" }),
    );
    const { task } = await service.createTask(userId, { prompt: "do the thing", agentId: general.id });
    await executor.waitFor(task.id);

    const finished = await getTask(handle.db, task.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.result).toContain("answered by the fallback");
    // It tried the chosen model first, then the fallback — not the other way round.
    expect(seen[0]).toBe("scripted-1");
    expect(seen).toContain("scripted-2");
  });

  it("says on the timeline which model it switched to, so a price change is visible", async () => {
    const { service, executor, userId, general } = await setup(
      new ProviderError("unavailable", "Provider is down.", { provider: "scripted" }),
    );
    const { task } = await service.createTask(userId, { prompt: "do the thing", agentId: general.id });
    await executor.waitFor(task.id);

    const events = await listTaskEvents(handle.db, task.id);
    const switched = events.find((e) => e.description?.includes("Trying scripted-2"));
    expect(switched).toBeDefined();
    expect(switched?.status).toBe("warning");
  });

  it("does not fall back when the task was cancelled", async () => {
    // `aborted` is how Stop and the execution timeout surface. Retrying that
    // work on another model would ignore the very thing that stopped it.
    const { service, executor, userId, general, seen } = await setup(
      new ProviderError("aborted", "The request was cancelled.", { provider: "scripted" }),
    );
    const { task } = await service.createTask(userId, { prompt: "do the thing", agentId: general.id });
    await executor.waitFor(task.id);

    expect((await getTask(handle.db, task.id))?.status).toBe("failed");
    expect(seen).not.toContain("scripted-2");
  });

  it("does not fall back on a malformed request, which every model would reject", async () => {
    const { service, executor, userId, general, seen } = await setup(
      new ProviderError("invalid_request", "Bad request.", { provider: "scripted" }),
    );
    const { task } = await service.createTask(userId, { prompt: "do the thing", agentId: general.id });
    await executor.waitFor(task.id);

    expect((await getTask(handle.db, task.id))?.status).toBe("failed");
    expect(seen).not.toContain("scripted-2");
  });

  it("fails with the original error when no fallback is configured", async () => {
    const { service, executor, userId, general } = await setup(
      new ProviderError("rate_limited", "Out of quota.", { provider: "scripted" }),
      [],
    );
    const { task } = await service.createTask(userId, { prompt: "do the thing", agentId: general.id });
    await executor.waitFor(task.id);

    const finished = await getTask(handle.db, task.id);
    expect(finished?.status).toBe("failed");
    expect(JSON.stringify(finished?.error)).toContain("quota");
  });

  it("stays on the fallback for the rest of the task instead of retrying the dead model each call", async () => {
    // Measured against a real dead gateway, re-trying the failed model on every
    // call cost its full retry backoff again each time — 43 s of sleeping per
    // call. Once a fallback answers, later calls start from it.
    const { service, executor, userId, general, seen } = await setup(
      new ProviderError("unavailable", "Provider is down.", { provider: "scripted" }),
    );
    const { task } = await service.createTask(userId, { prompt: "do the thing", agentId: general.id });
    await executor.waitFor(task.id);

    expect(seen.filter((m) => m === "scripted-1")).toHaveLength(1);
    // Planning and the step both ran, and only the first call touched the dead model.
    expect(seen.filter((m) => m === "scripted-2").length).toBeGreaterThan(1);
  });

  it("carries a fallback found during routing into the rest of the task", async () => {
    // Routing runs on a copy of the run state because it has its own timeout
    // signal. Without carrying the result back, planning re-tried the dead
    // model and paid its whole backoff a second time — seen live as two
    // 4-attempt failure groups instead of one.
    const { service, executor, userId, seen } = await setup(
      new ProviderError("unavailable", "Provider is down.", { provider: "scripted" }),
    );
    // No agentId, so the task is routed rather than assigned.
    const { task } = await service.createTask(userId, { prompt: "do the thing" });
    await executor.waitFor(task.id);

    expect(seen.filter((m) => m === "scripted-1")).toHaveLength(1);
  });

  it("skips a fallback id that does not resolve and keeps going", async () => {
    const { service, executor, userId, general, seen } = await setup(
      new ProviderError("model_not_found", "No such model.", { provider: "scripted" }),
      ["does-not-exist", "scripted-2"],
    );
    const { task } = await service.createTask(userId, { prompt: "do the thing", agentId: general.id });
    await executor.waitFor(task.id);

    expect((await getTask(handle.db, task.id))?.status).toBe("completed");
    expect(seen).toContain("scripted-2");
  });
});
