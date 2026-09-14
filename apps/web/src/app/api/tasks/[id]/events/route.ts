import { createTaskEventStream, toTaskEvent } from "@aiw/agents";
import { getDatabase, getTaskForUser, listTaskEvents } from "@aiw/database";
import { getAgentServices } from "@/server/agents";
import { errorResponse, HttpError, isUuid } from "@/server/http";
import { requireApiSession } from "@/server/session";

function cursor(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * GET /api/tasks/:id/events
 * - `Accept: text/event-stream`: live SSE stream (replays after `Last-Event-ID` or `?after=`)
 * - otherwise: JSON `{ events }` history
 */
export async function GET(request: Request, ctx: RouteContext<"/api/tasks/[id]/events">): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Task not found.");

    const db = getDatabase();
    const task = await getTaskForUser(db, user.id, id);
    if (!task) throw new HttpError(404, "not_found", "Task not found.");

    const url = new URL(request.url);
    const afterId = cursor(request.headers.get("last-event-id")) || cursor(url.searchParams.get("after"));

    if (!request.headers.get("accept")?.includes("text/event-stream")) {
      const rows = await listTaskEvents(db, id, { afterId, limit: 1000 });
      return Response.json({ events: rows.map(toTaskEvent) });
    }

    const stream = createTaskEventStream({ db, bus: getAgentServices().bus, taskId: id, afterId });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
