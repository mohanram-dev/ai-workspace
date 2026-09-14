import { getDatabase, getScreenshotForUser } from "@aiw/database";
import { errorResponse, HttpError, isUuid } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/tasks/:id/screenshots/:screenshotId — the stored JPEG (owner only). */
export async function GET(request: Request, ctx: RouteContext<"/api/tasks/[id]/screenshots/[screenshotId]">): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const { id, screenshotId } = await ctx.params;
    if (!isUuid(id) || !isUuid(screenshotId)) throw new HttpError(404, "not_found", "Screenshot not found.");
    const row = await getScreenshotForUser(getDatabase(), user.id, id, screenshotId);
    if (!row) throw new HttpError(404, "not_found", "Screenshot not found.");
    return new Response(new Uint8Array(row.image), {
      headers: {
        "Content-Type": row.mimeType,
        "Content-Length": String(row.bytes),
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": `inline; filename="screenshot-${row.id}.jpg"`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
