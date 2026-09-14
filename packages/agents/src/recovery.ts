import { cancelPendingApprovalsForTasks, failInterruptedTasks, type Database } from "@aiw/database";
import { TaskFailure, toTaskError } from "./errors";
import type { TaskEventRecorder } from "./events";

/**
 * Run once at server start: tasks still marked queued/planning/running were
 * owned by a process that no longer exists. Mark them failed so the user can
 * continue them. Assumes a single server instance (Phase 12 adds a worker).
 */
export async function recoverInterruptedTasks(db: Database, events: TaskEventRecorder): Promise<string[]> {
  const error = toTaskError(new TaskFailure("interrupted"), null);
  const tasks = await failInterruptedTasks(db, error);
  // Their approval prompts belong to a process that no longer exists.
  await cancelPendingApprovalsForTasks(db, tasks.map((t) => t.id), "The task was interrupted when the server restarted.");
  for (const task of tasks) {
    await events.emit({ taskId: task.id, userId: task.userId }, "TASK_FAILED", {
      description: `${error.title}: ${error.message}`,
      status: "error",
      data: { error },
    });
  }
  return tasks.map((t) => t.id);
}
