import type { TaskStatus } from "@aiw/shared";
import type { AgentRuntime } from "./runtime";

/** Starts and stops task executions. @aiw/queue provides a Redis/BullMQ-backed implementation. */
export interface TaskExecutor {
  start(taskId: string): void;
  /**
   * Signals a running task to stop. Resolves false when the task is not running
   * anywhere, so the caller records the cancellation itself. Asynchronous
   * because a queue-backed executor has to ask another process.
   */
  stop(taskId: string): Promise<boolean>;
}

/**
 * Runs tasks inside the current Node.js process, outside the HTTP request that
 * created them. Suitable for a single long-lived server (`next start`).
 */
export class InProcessTaskExecutor implements TaskExecutor {
  private readonly running = new Map<string, { controller: AbortController; done: Promise<TaskStatus | null> }>();

  constructor(private readonly runtime: Pick<AgentRuntime, "execute">) {}

  start(taskId: string): void {
    if (this.running.has(taskId)) return;
    const controller = new AbortController();
    const done = this.runtime
      .execute(taskId, controller.signal)
      .catch((error: unknown) => {
        console.error(`Task ${taskId} execution crashed`, error);
        return null;
      })
      .finally(() => {
        if (this.running.get(taskId)?.controller === controller) this.running.delete(taskId);
      });
    this.running.set(taskId, { controller, done });
  }

  async stop(taskId: string): Promise<boolean> {
    const entry = this.running.get(taskId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Resolves when the task's current run ends (used by tests and shutdown). */
  async waitFor(taskId: string): Promise<TaskStatus | null> {
    return (await this.running.get(taskId)?.done) ?? null;
  }
}
