import type { AgentRuntime } from "@aiw/agents";
import type { TaskStatus } from "@aiw/shared";
import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { KEY_PREFIX, TASK_QUEUE } from "./connection";
import { runningKey, stopChannel, type TaskJobData } from "./executor";

/** How long the running marker survives without a heartbeat, so a killed worker does not leave a task looking alive. */
const RUNNING_TTL_SECONDS = 60;
const HEARTBEAT_MS = 20_000;

export interface TaskWorkerOptions {
  runtime: Pick<AgentRuntime, "execute">;
  /** Blocking connection for BullMQ. */
  connection: Redis;
  /** Ordinary connection for the running marker. */
  commands: Redis;
  /** Subscriber connection for stop signals. */
  subscriber: Redis;
  /** Tasks this worker runs at once. */
  concurrency?: number;
  onStarted?: (taskId: string) => void;
  onFinished?: (taskId: string, status: TaskStatus | null) => void;
}

/**
 * Consumes the task queue and runs each task through the ordinary AgentRuntime.
 * Nothing about execution changes here: the same agents, tools, permissions,
 * approvals and events apply; only the process differs.
 */
export class TaskWorker {
  private readonly worker: Worker<TaskJobData>;
  private readonly running = new Map<string, AbortController>();
  private handlerAttached = false;

  constructor(private readonly options: TaskWorkerOptions) {
    this.worker = new Worker<TaskJobData>(TASK_QUEUE, (job) => this.run(job), {
      connection: options.connection,
      prefix: KEY_PREFIX,
      concurrency: options.concurrency ?? 3,
      // A task can legitimately run for many minutes; the agent's own time limit
      // is the real bound, so do not let BullMQ declare it stalled.
      lockDuration: 120_000,
      stalledInterval: 60_000,
    });
    this.worker.on("failed", (job, error) => {
      console.error(`Task job ${job?.data.taskId ?? "?"} failed`, error);
    });
  }

  private attachStopHandler(): void {
    if (this.handlerAttached) return;
    this.handlerAttached = true;
    this.options.subscriber.on("message", (channelName: string) => {
      const taskId = channelName.slice(`${KEY_PREFIX}:stop:`.length);
      this.running.get(taskId)?.abort();
    });
  }

  private async run(job: Job<TaskJobData>): Promise<void> {
    const { taskId } = job.data;
    const { commands, subscriber, runtime } = this.options;
    const controller = new AbortController();
    this.running.set(taskId, controller);
    this.attachStopHandler();

    await subscriber.subscribe(stopChannel(taskId));
    await commands.set(runningKey(taskId), String(process.pid), "EX", RUNNING_TTL_SECONDS);
    const heartbeat = setInterval(() => {
      void commands.expire(runningKey(taskId), RUNNING_TTL_SECONDS).catch(() => {});
    }, HEARTBEAT_MS);
    this.options.onStarted?.(taskId);

    try {
      const status = await runtime.execute(taskId, controller.signal);
      this.options.onFinished?.(taskId, status);
    } finally {
      clearInterval(heartbeat);
      this.running.delete(taskId);
      await subscriber.unsubscribe(stopChannel(taskId)).catch(() => {});
      await commands.del(runningKey(taskId)).catch(() => {});
    }
  }

  /** Tasks this worker is running right now. */
  get activeTaskIds(): string[] {
    return [...this.running.keys()];
  }

  /**
   * Stops taking new jobs and waits for the ones in flight. Running tasks are
   * aborted first so they record themselves as cancelled rather than being
   * killed mid-step and recovered as interrupted.
   */
  async close(abortRunning = true): Promise<void> {
    if (abortRunning) for (const controller of this.running.values()) controller.abort();
    await this.worker.close();
  }
}
