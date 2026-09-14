import type { TaskExecutor } from "@aiw/agents";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { KEY_PREFIX, TASK_QUEUE } from "./connection";

export interface TaskJobData {
  taskId: string;
}

/** Redis key a worker holds while it is actually running a task. */
export function runningKey(taskId: string): string {
  return `${KEY_PREFIX}:running:${taskId}`;
}

/** Channel a stop request is published on; the worker running the task listens. */
export function stopChannel(taskId: string): string {
  return `${KEY_PREFIX}:stop:${taskId}`;
}

/**
 * Hands task execution to a worker process over BullMQ (spec §44). The web
 * process only enqueues and signals; it never runs an agent itself, so a slow
 * task cannot block request handling and a deploy of the web tier does not kill
 * running work.
 */
export class QueueTaskExecutor implements TaskExecutor {
  readonly queue: Queue<TaskJobData>;

  constructor(
    connection: Redis,
    private readonly signals: Redis,
  ) {
    this.queue = new Queue<TaskJobData>(TASK_QUEUE, {
      connection,
      prefix: KEY_PREFIX,
      defaultJobOptions: {
        // The runtime records its own failures in the task row, so a job never
        // needs a second attempt: a retry is an explicit user action.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    });
  }

  start(taskId: string): void {
    // The job id is the task id, so double-starting one task is a no-op while it
    // is still queued. claimQueuedTask is the real guard once it is running.
    void this.queue.add("task", { taskId }, { jobId: taskId }).catch((error: unknown) => {
      console.error(`Could not enqueue task ${taskId}`, error);
    });
  }

  async stop(taskId: string): Promise<boolean> {
    // Still waiting in the queue: drop it and let the caller cancel the row.
    const job = await this.queue.getJob(taskId).catch(() => null);
    if (job) {
      const state = await job.getState().catch(() => "unknown");
      if (state === "waiting" || state === "delayed" || state === "prioritized") {
        await job.remove().catch(() => {});
        return false;
      }
    }
    // Running somewhere: ask that worker to abort. Its own finally block writes
    // the cancelled status, so the caller must not.
    const running = await this.signals.exists(runningKey(taskId));
    if (!running) return false;
    await this.signals.publish(stopChannel(taskId), "stop");
    return true;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
