import { existsSync } from "node:fs";
import { recoverInterruptedTasks } from "@aiw/agents";
import { getDatabase } from "@aiw/database";
import { closeRedis, createRedis, TaskWorker } from "@aiw/queue";
import { getAgentServices, getBrowserManager, getComputerManager, getQueueRuntime, getScheduler, getServerEnv } from "@aiw/runtime";

// Monorepo: load the shared root .env before anything reads it. Real
// environment variables win, so a container's own configuration is untouched.
const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/**
 * The worker tier (spec §44). It runs agent tasks taken from the queue, using
 * exactly the same runtime, tools, permissions and approvals as the web server
 * would; only the process differs. Without REDIS_URL there is nothing to
 * consume, so it refuses to start rather than sitting there doing nothing.
 */
async function main(): Promise<void> {
  const env = getServerEnv();
  if (!env.REDIS_URL) {
    console.error("The worker needs REDIS_URL. Without it the web server runs tasks itself and no worker is required.");
    process.exit(1);
  }

  const queue = getQueueRuntime();
  if (!queue) throw new Error("REDIS_URL is set but the queue runtime was not created.");
  const services = getAgentServices();
  const db = getDatabase();

  // Tasks left running by a previous worker belong to a process that is gone.
  try {
    const recovered = await recoverInterruptedTasks(db, services.events);
    if (recovered.length > 0) console.warn(`Marked ${recovered.length} interrupted task(s) as failed.`);
  } catch (error) {
    console.error("Could not recover interrupted tasks", error);
  }

  // BullMQ blocks on its connection, and the stop listener has to be a
  // subscriber, so both need connections of their own.
  const connection = createRedis({ url: env.REDIS_URL, blocking: true });
  const subscriber = createRedis({ url: env.REDIS_URL });
  for (const [name, client] of [
    ["worker", connection],
    ["stop-listener", subscriber],
  ] as const) {
    client.on("error", (error: Error) => console.error(`Redis ${name} connection error: ${error.message}`));
  }

  const worker = new TaskWorker({
    runtime: services.runtime,
    connection,
    subscriber,
    commands: queue.commands,
    concurrency: env.WORKER_CONCURRENCY,
    onStarted: (taskId) => console.info(`Task ${taskId} started`),
    onFinished: (taskId, status) => console.info(`Task ${taskId} ${status ?? "not claimable"}`),
  });

  if (env.RUN_SCHEDULER) {
    getScheduler().start();
    console.info("Schedule ticker started.");
  }
  console.info(`Worker ready: concurrency ${env.WORKER_CONCURRENCY}, queue ${env.REDIS_URL.replace(/\/\/.*@/, "//")}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const active = worker.activeTaskIds;
    console.info(`${signal}: stopping${active.length ? `, aborting ${active.length} running task(s)` : ""}…`);
    // Abort first so each task records itself as cancelled instead of being
    // killed mid-step and recovered as interrupted on the next start.
    await worker.close(true);
    getScheduler().stop();
    await Promise.all([getBrowserManager().shutdown(), getComputerManager().shutdown()]).catch(() => {});
    await queue.close();
    await Promise.all([closeRedis(connection), closeRedis(subscriber)]);
    console.info("Worker stopped.");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("Worker failed to start", error);
  process.exit(1);
});
