import { getDatabase, getLastTaskEventId, getTaskForUser, listSubTasks, listTaskSteps, listScreenshotsForTask, listToolCallsForTask } from "@aiw/database";
import { toTaskWithStepsDto } from "@/server/agent-dto";
import { errorResponse, HttpError, isUuid } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/tasks/:id — task with its plan steps. */
export async function GET(request: Request, ctx: RouteContext<"/api/tasks/[id]">): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Task not found.");

    const db = getDatabase();
    const task = await getTaskForUser(db, user.id, id);
    if (!task) throw new HttpError(404, "not_found", "Task not found.");
    const [steps, lastEventId, toolCalls, screenshots, subTasks] = await Promise.all([
      listTaskSteps(db, id),
      getLastTaskEventId(db, id),
      listToolCallsForTask(db, id),
      listScreenshotsForTask(db, id),
      listSubTasks(db, id),
    ]);
    return Response.json(toTaskWithStepsDto(task, steps, lastEventId, toolCalls, screenshots, subTasks));
  } catch (error) {
    return errorResponse(error);
  }
}
