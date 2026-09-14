import { getDatabase, getTaskForUser } from "@aiw/database";
import { readPublishedFrame } from "@aiw/runtime";
import { getBrowserManager } from "@/server/browser";
import { errorResponse, HttpError, isUuid } from "@/server/http";
import { requireApiSession } from "@/server/session";

/**
 * GET /api/tasks/:id/browser/frame — the latest live preview frame of the
 * task's browser session (JPEG), or 204 when there is none. Frames are kept in
 * memory only; the SSE `browser` event tells clients when a new one exists.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/tasks/[id]/browser/frame">): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Task not found.");
    if (!(await getTaskForUser(getDatabase(), user.id, id))) throw new HttpError(404, "not_found", "Task not found.");
    // In queue mode the session runs in the worker, which publishes its newest
    // frame to Redis; otherwise the manager in this process holds it.
    const local = getBrowserManager().latestFrame(id);
    const published = local ? null : await readPublishedFrame("browser", id);
    const latest = local ?? (published ? { image: published.image, frame: { seq: published.seq, url: published.url } } : null);
    if (!latest) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    return new Response(new Uint8Array(latest.image), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-Frame-Seq": String(latest.frame.seq),
        "X-Frame-Url": encodeURI(latest.frame.url),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
