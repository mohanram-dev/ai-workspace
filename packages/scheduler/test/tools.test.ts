import { randomUUID } from "node:crypto";
import { createDatabase, createSchedule, createTask, listSchedulesForUser, schema, type DatabaseHandle } from "@aiw/database";
import { getTestDatabaseUrl } from "@aiw/database/testing";
import { isToolError, type AnyToolDefinition, type ToolContext } from "@aiw/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScheduleTools } from "../src";

let handle: DatabaseHandle;
beforeAll(() => {
  handle = createDatabase(getTestDatabaseUrl(), { max: 3 });
});
afterAll(async () => {
  await handle.close();
});

async function setup() {
  const userId = randomUUID();
  await handle.db.insert(schema.users).values({ id: userId, name: "Test", email: `${userId}@example.test` });
  const task = await createTask(handle.db, { userId, prompt: "set up a schedule", status: "running" });
  const tools = createScheduleTools({ db: handle.db });
  const byName = (name: string) => tools.find((t) => t.name === name)!;
  const context = { taskId: task.id } as ToolContext;
  const run = (tool: AnyToolDefinition, input: unknown) => tool.execute(input as never, context);
  return { userId, task, byName, run };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("expected the tool to fail");
  } catch (error) {
    if (!isToolError(error)) throw error;
    return error.message;
  }
}

describe("schedule.create (spec §26)", () => {
  it("creates a daily schedule and reports when it first runs", async () => {
    const { userId, byName, run } = await setup();
    const result = await run(byName("schedule.create"), {
      name: "AI news digest",
      prompt: "Search the news and write a file.",
      trigger: "daily",
      timeOfDay: "07:30",
      timezone: "Asia/Kolkata",
    });

    expect(result.summary).toContain("AI news digest");
    const saved = await listSchedulesForUser(handle.db, userId);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "AI news digest", timezone: "Asia/Kolkata", trigger: "daily", enabled: true });
    // 07:30 in Kolkata is 02:00 UTC.
    expect(saved[0]!.nextRunAt?.toISOString().slice(11, 16)).toBe("02:00");
  });

  it("needs a human: it is DESTRUCTIVE, because it commits unattended spend", () => {
    const tools = createScheduleTools({ db: handle.db });
    expect(tools.find((t) => t.name === "schedule.create")!.permission).toBe("DESTRUCTIVE");
    // Reading and switching off do not.
    expect(tools.find((t) => t.name === "schedule.list")!.permission).toBe("READ");
    expect(tools.find((t) => t.name === "schedule.disable")!.permission).toBe("WRITE");
  });

  it("refuses an interval below the floor, so a misheard 'every morning' cannot run all night", async () => {
    const { byName, run } = await setup();
    const message = await failure(
      run(byName("schedule.create"), { name: "Too often", prompt: "go", trigger: "interval", intervalMinutes: 1 }),
    );
    expect(message).toContain("every 15 minutes");
  });

  it("catches a cron that fires too often, without interpreting the expression", async () => {
    // The gap between the first two occurrences is measured instead.
    const { byName, run } = await setup();
    const message = await failure(
      run(byName("schedule.create"), { name: "Every minute", prompt: "go", trigger: "cron", cron: "* * * * *", timezone: "UTC" }),
    );
    expect(message).toContain("every 15 minutes");
  });

  it("refuses a time zone the server does not know rather than storing it", async () => {
    const { byName, run } = await setup();
    const message = await failure(
      run(byName("schedule.create"), { name: "Typo", prompt: "go", trigger: "daily", timeOfDay: "07:00", timezone: "Asia/Kolkatta" }),
    );
    expect(message).toContain("Asia/Kolkata");
  });

  it("inherits the time zone of the user's existing schedules when none is given", async () => {
    const { userId, byName, run } = await setup();
    await createSchedule(handle.db, {
      userId,
      name: "Existing",
      prompt: "x",
      trigger: "daily",
      timeOfDay: "09:00",
      timezone: "Asia/Kolkata",
      nextRunAt: new Date(),
    });

    await run(byName("schedule.create"), { name: "Inherits", prompt: "go", trigger: "daily", timeOfDay: "07:00" });
    const saved = (await listSchedulesForUser(handle.db, userId)).find((s) => s.name === "Inherits");
    expect(saved?.timezone).toBe("Asia/Kolkata");
  });

  it("stops at the per-user ceiling", async () => {
    const { byName, run } = await setup();
    const tools = createScheduleTools({ db: handle.db, maxPerUser: 1 });
    const create = tools.find((t) => t.name === "schedule.create")!;
    await run(byName("schedule.create"), { name: "First", prompt: "go", trigger: "daily", timeOfDay: "07:00", timezone: "UTC" });

    const { task } = await setup();
    void task;
    const message = await failure(run(create, { name: "Second", prompt: "go", trigger: "daily", timeOfDay: "08:00", timezone: "UTC" }));
    expect(message).toContain("limit");
  });

  it("refuses a one-time schedule in the past instead of creating something that never runs", async () => {
    const { byName, run } = await setup();
    const message = await failure(
      run(byName("schedule.create"), { name: "Past", prompt: "go", trigger: "once", runAt: "2020-01-01T00:00:00.000Z", timezone: "UTC" }),
    );
    expect(message).toContain("never run");
  });
});

describe("schedule.list and schedule.disable", () => {
  it("lists what is set up and can switch one off", async () => {
    const { userId, byName, run } = await setup();
    await run(byName("schedule.create"), { name: "Digest", prompt: "go", trigger: "daily", timeOfDay: "07:00", timezone: "UTC" });

    const listed = await run(byName("schedule.list"), {});
    expect(listed.content).toContain("Digest");

    const id = (await listSchedulesForUser(handle.db, userId))[0]!.id;
    const disabled = await run(byName("schedule.disable"), { id });
    expect(disabled.summary).toContain("Digest");
    expect((await listSchedulesForUser(handle.db, userId))[0]!.enabled).toBe(false);
  });

  it("reports an id that is not there rather than pretending", async () => {
    const { byName, run } = await setup();
    expect(await failure(run(byName("schedule.disable"), { id: randomUUID() }))).toContain("no schedule");
  });
});
