import { getDatabase, markTemplateUsed } from "@aiw/database";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** POST /api/templates/:id/use — records a use, which moves the template to the top of the menu. */
export async function POST(request: Request, ctx: RouteContext<"/api/templates/[id]/use">): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id) || !(await markTemplateUsed(getDatabase(), user.id, id))) throw new HttpError(404, "not_found", "Template not found.");
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
