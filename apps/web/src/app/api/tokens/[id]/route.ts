import { deleteApiTokenForUser, getDatabase, writeAuditLog } from "@aiw/database";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** DELETE /api/tokens/:id — revoke a token immediately. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/tokens/[id]">): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    const db = getDatabase();
    if (!isUuid(id) || !(await deleteApiTokenForUser(db, user.id, id))) throw new HttpError(404, "not_found", "Token not found.");
    await writeAuditLog(db, { userId: user.id, action: "api_token.deleted", resourceType: "api_token", resourceId: id });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
