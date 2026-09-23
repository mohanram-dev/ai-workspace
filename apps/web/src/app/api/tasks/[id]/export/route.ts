import { getDatabase, getTaskForUser, listSubTasks, listTaskSteps, listToolCallsForTask } from "@aiw/database";
import { downloadHeaders, exportFilename, taskMarkdown } from "@/server/export";
import { errorResponse, HttpError, isUuid } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/tasks/:id/export — the task as a Markdown report: plan, steps, tool calls, result and usage. */
export async function GET(request: Request, ctx: RouteContext<"/api/tasks/[id]/export">): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Task not found.");
    const db = getDatabase();
    const task = await getTaskForUser(db, user.id, id);
    if (!task) throw new HttpError(404, "not_found", "Task not found.");

    const [steps, toolCalls, subTasks] = await Promise.all([listTaskSteps(db, task.id), listToolCallsForTask(db, task.id), listSubTasks(db, task.id)]);
    const title = task.prompt.split("\n").find((l) => l.trim())?.trim() ?? "task";
    return new Response(taskMarkdown(task, steps, toolCalls, subTasks), {
      headers: downloadHeaders(exportFilename(`task ${title}`, "md"), "text/markdown; charset=utf-8"),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
