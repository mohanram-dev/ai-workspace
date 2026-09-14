import { getDatabase, getTaskForUser } from "@aiw/database";
import { readPublishedFrame } from "@aiw/runtime";
import { getComputerManager } from "@/server/computer";
import { errorResponse, HttpError, isUuid } from "@/server/http";
import { requireApiSession } from "@/server/session";

/**
 * GET /api/tasks/:id/computer/frame — the latest live desktop frame (JPEG) of
 * the task's computer session, or 204 when there is none. Frames live in
 * memory only; the SSE `computer` event announces new ones.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/tasks/[id]/computer/frame">): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Task not found.");
    if (!(await getTaskForUser(getDatabase(), user.id, id))) throw new HttpError(404, "not_found", "Task not found.");
    // In queue mode the session runs in the worker, which publishes its newest
    // frame to Redis; otherwise the manager in this process holds it.
    const local = getComputerManager().latestFrame(id);
    const published = local ? null : await readPublishedFrame("computer", id);
    const latest = local ?? (published ? { image: published.image, frame: { seq: published.seq, url: published.url } } : null);
    if (!latest) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    return new Response(new Uint8Array(latest.image), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Frame-Seq": String(latest.frame.seq) },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
