import type { TaskBusMessage } from "@aiw/agents";
import type { TaskStatus } from "@aiw/shared";
import { afterAll, describe, expect, it } from "vitest";
import { closeRedis, createRedis, KEY_PREFIX, QueueTaskExecutor, RedisFrameStore, RedisTaskEventBus, runningKey, TaskWorker } from "../src";
import type { RedisClient } from "../src";

/** These exercise real Redis; without one there is nothing meaningful to assert. */
const REDIS_URL = process.env.REDIS_TEST_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const clients: RedisClient[] = [];
const track = <T extends RedisClient>(client: T): T => {
  clients.push(client);
  return client;
};

// Probed before the suites are declared, so a machine without Redis skips them
// with a message instead of failing.
const reachable = await (async () => {
  const probe = createRedis({ url: REDIS_URL });
  try {
    await probe.ping();
    return true;
  } catch {
    console.warn(`No Redis at ${REDIS_URL}; skipping queue tests. Start one with: docker compose up -d redis`);
    return false;
  } finally {
    await closeRedis(probe);
  }
})();

afterAll(async () => {
  await Promise.all(clients.map(closeRedis));
});

/** Clears this test run's keys so a rerun starts clean. */
async function reset(): Promise<void> {
  const client = track(createRedis({ url: REDIS_URL }));
  const keys = await client.keys(`${KEY_PREFIX}:*`);
  if (keys.length > 0) await client.del(...keys);
}

const waitFor = async (predicate: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for a condition");
};

describe.skipIf(!reachable)("redis task event bus", () => {
  it("delivers an event published by another process", async () => {
    await reset();
    const publisherSide = new RedisTaskEventBus(track(createRedis({ url: REDIS_URL })), track(createRedis({ url: REDIS_URL })));
    const subscriberSide = new RedisTaskEventBus(track(createRedis({ url: REDIS_URL })), track(createRedis({ url: REDIS_URL })));

    const received: TaskBusMessage[] = [];
    const unsubscribe = subscriberSide.subscribe("task-1", (m) => received.push(m));
    // Subscribing is asynchronous; publish once it has taken effect.
    await new Promise((r) => setTimeout(r, 200));

    publisherSide.publish({ kind: "delta", delta: { taskId: "task-1", stepId: "step-1", text: "hello" } });
    publisherSide.publish({ kind: "delta", delta: { taskId: "other", stepId: "s", text: "not mine" } });
    await waitFor(() => received.length > 0);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "delta", delta: { taskId: "task-1", text: "hello" } });
    unsubscribe();
  });
});

describe.skipIf(!reachable)("queue executor and worker", () => {
  it("runs a queued task in the worker and reports it back", async () => {
    await reset();
    const executor = new QueueTaskExecutor(track(createRedis({ url: REDIS_URL, blocking: true })), track(createRedis({ url: REDIS_URL })));

    const executed: string[] = [];
    const worker = new TaskWorker({
      runtime: {
        execute: async (taskId) => {
          executed.push(taskId);
          return "completed" satisfies TaskStatus;
        },
      },
      connection: track(createRedis({ url: REDIS_URL, blocking: true })),
      commands: track(createRedis({ url: REDIS_URL })),
      subscriber: track(createRedis({ url: REDIS_URL })),
    });

    executor.start("task-run");
    await waitFor(() => executed.includes("task-run"));
    expect(executed).toEqual(["task-run"]);

    await worker.close();
    await executor.close();
  });

  it("aborts a running task when another process asks it to stop", async () => {
    await reset();
    const commands = track(createRedis({ url: REDIS_URL }));
    const executor = new QueueTaskExecutor(track(createRedis({ url: REDIS_URL, blocking: true })), commands);

    let aborted = false;
    let started = false;
    const worker = new TaskWorker({
      runtime: {
        execute: async (_taskId, signal) => {
          started = true;
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          aborted = signal.aborted;
          return "cancelled" satisfies TaskStatus;
        },
      },
      connection: track(createRedis({ url: REDIS_URL, blocking: true })),
      commands: track(createRedis({ url: REDIS_URL })),
      subscriber: track(createRedis({ url: REDIS_URL })),
    });

    executor.start("task-stop");
    await waitFor(() => started);
    // The worker marks the task as running so the web tier can tell.
    expect(await commands.exists(runningKey("task-stop"))).toBe(1);

    expect(await executor.stop("task-stop")).toBe(true);
    await waitFor(() => aborted);
    expect(aborted).toBe(true);

    await worker.close();
    await executor.close();
  });

  it("reports false for a task that is not running, so the caller cancels it itself", async () => {
    await reset();
    const executor = new QueueTaskExecutor(track(createRedis({ url: REDIS_URL, blocking: true })), track(createRedis({ url: REDIS_URL })));
    expect(await executor.stop("never-started")).toBe(false);

    // Queued but with no worker running: the job is dropped and the caller told.
    executor.start("still-waiting");
    await new Promise((r) => setTimeout(r, 300));
    expect(await executor.stop("still-waiting")).toBe(false);
    expect(await executor.queue.getJob("still-waiting")).toBeUndefined();
    await executor.close();
  });
});

describe.skipIf(!reachable)("live frame handoff", () => {
  it("carries the newest frame from the worker to the web tier", async () => {
    await reset();
    const store = new RedisFrameStore(track(createRedis({ url: REDIS_URL })));
    const image = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x0a, 0x42]);

    expect(await store.get("browser", "task-frame")).toBeNull();
    await store.put("browser", "task-frame", { image, seq: 7, url: "https://example.com/aé" });

    const read = await store.get("browser", "task-frame");
    expect(read?.seq).toBe(7);
    expect(read?.url).toBe("https://example.com/aé");
    // Binary must survive untouched: a corrupted JPEG is a blank preview.
    expect(Buffer.compare(read!.image, image)).toBe(0);

    // Only the newest frame is kept.
    await store.put("browser", "task-frame", { image: Buffer.from([1, 2, 3]), seq: 8, url: "" });
    expect((await store.get("browser", "task-frame"))?.seq).toBe(8);
  });
});
