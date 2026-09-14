import { getDatabase, getLastTaskEventId, listTaskSteps, listScreenshotsForTask, listToolCallsForTask, writeAuditLog, type TaskWithAgent } from "@aiw/database";
import { toTaskWithStepsDto } from "./agent-dto";
import { getAgentServices } from "./agents";
import { getServerEnv } from "./env";
import { assertSameOrigin, errorResponse, HttpError, isUuid } from "./http";
import { requireApiSession } from "./session";

type Action = "stop" | "retry" | "continue" | "pause" | "resume";

/** Shared handler for POST /api/tasks/:id/{stop,retry,continue,pause,resume}. */
export async function handleTaskControl(
  request: Request,
  params: Promise<{ id: string }>,
  action: Action,
): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Task not found.");

    const { tasks } = getAgentServices();
    let task: TaskWithAgent;
    if (action === "stop") task = await tasks.stopTask(user.id, id);
    else if (action === "retry") task = await tasks.retryTask(user.id, id);
    else if (action === "pause") task = await tasks.pauseTask(user.id, id);
    else if (action === "resume") task = await tasks.resumeTask(user.id, id);
    else task = await tasks.continueTask(user.id, id);

    const db = getDatabase();
    await writeAuditLog(db, {
      userId: user.id,
      action: `task.${action}`,
      resourceType: "task",
      resourceId: task.id,
      metadata: action === "retry" ? { retryOf: id } : null,
    });
    const [steps, lastEventId, toolCalls, screenshots] = await Promise.all([
    listTaskSteps(db, task.id),
    getLastTaskEventId(db, task.id),
    listToolCallsForTask(db, task.id),
    listScreenshotsForTask(db, task.id),
  ]);
    return Response.json(toTaskWithStepsDto(task, steps, lastEventId, toolCalls, screenshots));
  } catch (error) {
    return errorResponse(error);
  }
}
