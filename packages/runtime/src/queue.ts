import { closeRedis, createRedis, QueueTaskExecutor, RedisFrameStore, RedisTaskEventBus, type RedisClient } from "@aiw/queue";
import { getServerEnv } from "./env";

export interface QueueRuntime {
  /** Enqueues tasks for the worker tier and signals stops across processes. */
  executor: QueueTaskExecutor;
  /** Task events, published by whichever process runs the task. */
  bus: RedisTaskEventBus;
  /** Live browser/desktop preview frames handed from the worker to the web tier. */
  frames: RedisFrameStore;
  /** Ordinary command connection, reused by the worker for its running markers. */
  commands: RedisClient;
  close(): Promise<void>;
}

const globalForQueue = globalThis as unknown as { __aiwQueue?: QueueRuntime | null };

/**
 * Redis-backed execution (spec §44). Returns null when REDIS_URL is unset, in
 * which case the app runs everything in one process exactly as before — that is
 * the supported single-server setup, not a degraded mode.
 */
export function getQueueRuntime(): QueueRuntime | null {
  if (globalForQueue.__aiwQueue === undefined) {
    const url = getServerEnv().REDIS_URL;
    globalForQueue.__aiwQueue = url ? build(url) : null;
  }
  return globalForQueue.__aiwQueue;
}

function build(url: string): QueueRuntime {
  // A subscribed connection cannot run ordinary commands, and BullMQ blocks on
  // its own, so each role gets the connection it needs.
  const commands = createRedis({ url });
  const subscriber = createRedis({ url });
  const queueConnection = createRedis({ url, blocking: true });

  for (const [name, client] of [
    ["commands", commands],
    ["subscriber", subscriber],
    ["queue", queueConnection],
  ] as const) {
    client.on("error", (error: Error) => console.error(`Redis ${name} connection error: ${error.message}`));
  }

  return {
    executor: new QueueTaskExecutor(queueConnection, commands),
    bus: new RedisTaskEventBus(commands, subscriber),
    frames: new RedisFrameStore(commands),
    commands,
    close: async () => {
      await Promise.all([closeRedis(commands), closeRedis(subscriber), closeRedis(queueConnection)]);
    },
  };
}
