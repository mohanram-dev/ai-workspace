import { Redis, type RedisOptions } from "ioredis";

/** The Redis client type, re-exported so dependants need not depend on ioredis directly. */
export type RedisClient = Redis;

/** Queue name shared by the web process (producer) and the worker (consumer). BullMQ forbids ":" here; KEY_PREFIX namespaces it. */
export const TASK_QUEUE = "tasks";

/** Redis key prefix, so one Redis can host several deployments. */
export const KEY_PREFIX = "aiw";

export interface RedisConnectionOptions {
  url: string;
  /** BullMQ requires `maxRetriesPerRequest: null` on the connections it blocks on. */
  blocking?: boolean;
}

/**
 * A Redis client. Connections are cheap but not free: a blocking consumer needs
 * its own, and so does every pub/sub subscriber, because a subscribed
 * connection cannot run ordinary commands.
 */
export function createRedis(options: RedisConnectionOptions): Redis {
  const config: RedisOptions = {
    // Keep retrying: a worker that outlives a Redis restart should reconnect.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    ...(options.blocking ? { maxRetriesPerRequest: null } : {}),
  };
  return new Redis(options.url, config);
}

/** Closes a client without throwing if it is already gone. */
export async function closeRedis(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
