import { randomUUID } from "node:crypto";
import {
  createConversation,
  createDatabase,
  createSchedule,
  deleteConversationForUser,
  getConversationForUser,
  getScheduleForUser,
  getTask,
  listScheduleRuns,
  schema,
  updateScheduleForUser,
  type DatabaseHandle,
} from "@aiw/database";
import { AppError } from "@aiw/shared";
import { getTestDatabaseUrl, resetTestDatabase } from "@aiw/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scheduler, type ScheduleTaskStarter } from "../src";

let handle: DatabaseHandle;

beforeAll(async () => {
  // tick() fires every due schedule in the database, not just this file's, and
  // the package-wide reset runs once before all files. Without a reset here, a
  // due schedule left by whichever file ran first is counted as well.
  await resetTestDatabase();
  handle = createDatabase(getTestDatabaseUrl(), { max: 3 });
});
afterAll(async () => {
  await handle.close();
});

async function createUser(): Promise<string> {
  const id = randomUUID();
  await handle.db.insert(schema.users).values({ id, name: "Scheduler", email: `${id}@example.test` });
  return id;
}

/**
 * Records what the scheduler asked for, and can refuse like a busy task
 * service: over the running-task limit, or with the shared conversation still
 * working (TaskService answers 409 for that).
 */
function taskStarter(behaviour: "ok" | "busy" | "conversation-busy" = "ok"): ScheduleTaskStarter & { calls: Record<string, unknown>[]; options: unknown[] } {
  const calls: Record<string, unknown>[] = [];
  const options: unknown[] = [];
  return {
    calls,
    options,
    async createTask(userId, input, taskOptions) {
      calls.push({ userId, ...input });
      options.push(taskOptions);
      if (behaviour === "busy") throw new Error("You already have 3 tasks running.");
      if (behaviour === "conversation-busy") throw new AppError(409, "conflict", "An agent is still working in this conversation.");
      const conversationId =
        input.conversationId ?? (await createConversation(handle.db, { userId, title: input.prompt, ...(input.projectId ? { projectId: input.projectId } : {}) })).id;
      const [task] = await handle.db
        .insert(schema.tasks)
        .values({
          userId,
          prompt: input.prompt,
          status: "queued",
          agentId: input.agentId ?? null,
          projectId: input.projectId ?? null,
          conversationId,
          includeHistory: taskOptions?.includeHistory ?? true,
        })
        .returning();
      return { task: { id: task!.id }, conversation: { id: conversationId } };
    },
  };
}

describe("Scheduler", () => {
  it("starts a due schedule, records the run and moves to the next occurrence", async () => {
    const userId = await createUser();
    const due = new Date(Date.now() - 60_000);
    const schedule = await createSchedule(handle.db, {
      userId,
      name: "Hourly check",
      prompt: "Check the server health",
      trigger: "interval",
      intervalMinutes: 60,
      timezone: "UTC",
      nextRunAt: due,
    });
    const tasks = taskStarter();
    const scheduler = new Scheduler({ db: handle.db, tasks });

    expect(await scheduler.tick()).toBe(1);
    expect(tasks.calls).toEqual([{ userId, prompt: "Check the server health" }]);

    const after = await getScheduleForUser(handle.db, userId, schedule.id);
    expect(after!.runCount).toBe(1);
    expect(after!.lastRunAt).not.toBeNull();
    expect(after!.lastTaskId).not.toBeNull();
    // The next run is an hour after the time it was due, not an hour from now.
    expect(after!.nextRunAt?.getTime()).toBe(due.getTime() + 60 * 60_000);

    const runs = await listScheduleRuns(handle.db, schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "started", taskId: after!.lastTaskId, scheduledFor: due });

    // Not due any more.
    expect(await scheduler.tick()).toBe(0);
  });

  it("passes the agent, model and project through to the task", async () => {
    const userId = await createUser();
    const [agent] = await handle.db
      .insert(schema.agents)
      .values({ ownerId: userId, slug: "sched", name: "Sched agent", description: "d" })
      .returning();
    const [project] = await handle.db.insert(schema.projects).values({ ownerId: userId, name: "Nightly" }).returning();
    await createSchedule(handle.db, {
      userId,
      name: "Nightly report",
      prompt: "Write the report",
      trigger: "daily",
      timeOfDay: "02:00",
      timezone: "UTC",
      agentId: agent!.id,
      projectId: project!.id,
      model: "gemini-3.1-flash-lite",
      nextRunAt: new Date(Date.now() - 1000),
    });
    const tasks = taskStarter();
    await new Scheduler({ db: handle.db, tasks }).tick();
    expect(tasks.calls[0]).toMatchObject({ agentId: agent!.id, projectId: project!.id, model: "gemini-3.1-flash-lite" });
  });

  it("records a skipped run when the task cannot start, and still moves on", async () => {
    const userId = await createUser();
    const due = new Date(Date.now() - 1000);
    const schedule = await createSchedule(handle.db, {
      userId,
      name: "Busy",
      prompt: "Do something",
      trigger: "interval",
      intervalMinutes: 30,
      timezone: "UTC",
      nextRunAt: due,
    });
    await new Scheduler({ db: handle.db, tasks: taskStarter("busy") }).tick();

    const runs = await listScheduleRuns(handle.db, schedule.id);
    expect(runs[0]).toMatchObject({ status: "skipped", taskId: null });
    expect(runs[0]!.detail).toContain("3 tasks running");
    const after = await getScheduleForUser(handle.db, userId, schedule.id);
    expect(after!.nextRunAt?.getTime()).toBe(due.getTime() + 30 * 60_000);
  });

  it("runs a one-time schedule once and then stops", async () => {
    const userId = await createUser();
    const schedule = await createSchedule(handle.db, {
      userId,
      name: "One off",
      prompt: "Just once",
      trigger: "once",
      timezone: "UTC",
      runAt: new Date(Date.now() - 1000),
      nextRunAt: new Date(Date.now() - 1000),
    });
    const scheduler = new Scheduler({ db: handle.db, tasks: taskStarter() });
    expect(await scheduler.tick()).toBe(1);
    expect((await getScheduleForUser(handle.db, userId, schedule.id))!.nextRunAt).toBeNull();
    expect(await scheduler.tick()).toBe(0);
  });

  it("ignores disabled schedules and never double-fires one", async () => {
    const userId = await createUser();
    const due = new Date(Date.now() - 1000);
    await createSchedule(handle.db, {
      userId,
      name: "Disabled",
      prompt: "Should not run",
      trigger: "interval",
      intervalMinutes: 60,
      timezone: "UTC",
      enabled: false,
      nextRunAt: due,
    });
    const shared = await createSchedule(handle.db, {
      userId,
      name: "Contended",
      prompt: "Only once",
      trigger: "interval",
      intervalMinutes: 60,
      timezone: "UTC",
      nextRunAt: due,
    });

    const tasks = taskStarter();
    // Two tickers racing on the same schedule: exactly one claim wins.
    const [a, b] = await Promise.all([
      new Scheduler({ db: handle.db, tasks }).tick(),
      new Scheduler({ db: handle.db, tasks }).tick(),
    ]);
    expect(a + b).toBe(1);
    expect(await listScheduleRuns(handle.db, shared.id)).toHaveLength(1);
    expect(tasks.calls).toHaveLength(1);
  });

  it("posts every run to the schedule's own conversation, each run without the earlier ones as history", async () => {
    const userId = await createUser();
    const due = new Date(Date.now() - 1000);
    const schedule = await createSchedule(handle.db, {
      userId,
      name: "AI news digest",
      prompt: "Every morning, summarise AI news",
      trigger: "interval",
      intervalMinutes: 60,
      timezone: "UTC",
      nextRunAt: due,
    });
    const tasks = taskStarter();
    const scheduler = new Scheduler({ db: handle.db, tasks });

    expect(await scheduler.tick()).toBe(1);
    const first = (await getScheduleForUser(handle.db, userId, schedule.id))!;
    expect(first.conversationId).not.toBeNull();
    // Named after the schedule, not after the prompt's first words.
    expect((await getConversationForUser(handle.db, userId, first.conversationId!))?.title).toBe("AI news digest");
    expect(tasks.options[0]).toEqual({ includeHistory: false });
    expect((await getTask(handle.db, first.lastTaskId!))?.includeHistory).toBe(false);

    await updateScheduleForUser(handle.db, userId, schedule.id, { nextRunAt: new Date(Date.now() - 1000) });
    expect(await scheduler.tick()).toBe(1);
    expect(tasks.calls[1]).toMatchObject({ conversationId: first.conversationId });
    expect((await getScheduleForUser(handle.db, userId, schedule.id))?.conversationId).toBe(first.conversationId);
  });

  it("starts a new conversation when the old one was deleted or is in another project", async () => {
    const userId = await createUser();
    const schedule = await createSchedule(handle.db, {
      userId,
      name: "Weekly check",
      prompt: "Check the issues",
      trigger: "interval",
      intervalMinutes: 60,
      timezone: "UTC",
      nextRunAt: new Date(Date.now() - 1000),
    });
    const tasks = taskStarter();
    const scheduler = new Scheduler({ db: handle.db, tasks });
    await scheduler.tick();
    const firstConversation = (await getScheduleForUser(handle.db, userId, schedule.id))!.conversationId!;

    await deleteConversationForUser(handle.db, userId, firstConversation);
    await updateScheduleForUser(handle.db, userId, schedule.id, { nextRunAt: new Date(Date.now() - 1000) });
    await scheduler.tick();
    const second = (await getScheduleForUser(handle.db, userId, schedule.id))!.conversationId!;
    expect(tasks.calls[1]).not.toHaveProperty("conversationId");
    expect(second).not.toBe(firstConversation);

    const [project] = await handle.db.insert(schema.projects).values({ ownerId: userId, name: "Elsewhere" }).returning();
    await updateScheduleForUser(handle.db, userId, schedule.id, { projectId: project!.id, nextRunAt: new Date(Date.now() - 1000) });
    await scheduler.tick();
    // The personal conversation is not reused for a project schedule.
    expect(tasks.calls[2]).toMatchObject({ projectId: project!.id });
    expect(tasks.calls[2]).not.toHaveProperty("conversationId");
  });

  it("says why a run was skipped when the previous one is still working", async () => {
    const userId = await createUser();
    const schedule = await createSchedule(handle.db, {
      userId,
      name: "Slow job",
      prompt: "Takes a while",
      trigger: "interval",
      intervalMinutes: 5,
      timezone: "UTC",
      nextRunAt: new Date(Date.now() - 1000),
    });
    await new Scheduler({ db: handle.db, tasks: taskStarter("conversation-busy") }).tick();
    const [run] = await listScheduleRuns(handle.db, schedule.id);
    expect(run).toMatchObject({ status: "skipped", detail: "The previous run of this schedule is still working. Wait for it to finish, or stop it." });
  });

  it("disables a schedule whose trigger stops being usable", async () => {
    const userId = await createUser();
    const due = new Date(Date.now() - 1000);
    const schedule = await createSchedule(handle.db, {
      userId,
      name: "Broken",
      prompt: "Never runs",
      trigger: "cron",
      cron: "totally broken",
      timezone: "UTC",
      nextRunAt: due,
    });
    const tasks = taskStarter();
    expect(await new Scheduler({ db: handle.db, tasks }).tick()).toBe(0);
    expect(tasks.calls).toHaveLength(0);

    const after = await getScheduleForUser(handle.db, userId, schedule.id);
    expect(after).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await listScheduleRuns(handle.db, schedule.id))[0]).toMatchObject({ status: "failed" });
  });
});
