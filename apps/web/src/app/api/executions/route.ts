import { getDatabase, listTasksForUser, listTaskStepsForTasks } from "@aiw/database";
import { listTasksQuerySchema, type TaskStatus } from "@aiw/shared";
import { toTaskDto } from "@/server/agent-dto";
import { errorResponse, HttpError } from "@/server/http";
import { requireApiSession } from "@/server/session";

const STATUS_FILTERS: Record<string, TaskStatus[] | undefined> = {
  all: undefined,
  active: ["queued", "planning", "running", "waiting_for_tool", "waiting_for_approval", "paused"],
  completed: ["completed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

/**
 * GET /api/executions (spec §35) — the execution history. An execution is a
 * task run, whether you started it, a schedule fired it or another agent
 * delegated it, so this is the task list with its origin made explicit.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const query = listTasksQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new HttpError(400, "bad_request", "Invalid query parameters.");

    const db = getDatabase();
    const tasks = await listTasksForUser(db, user.id, { statuses: STATUS_FILTERS[query.data.status], limit: query.data.limit });
    const steps = await listTaskStepsForTasks(db, tasks.map((t) => t.id));

    const executions = tasks.map((task) => {
      const dto = toTaskDto(task, steps.filter((s) => s.taskId === task.id));
      return {
        ...dto,
        origin: task.parentTaskId ? ("delegated" as const) : task.retryOfTaskId ? ("retry" as const) : ("user" as const),
      };
    });
    return Response.json({ executions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
