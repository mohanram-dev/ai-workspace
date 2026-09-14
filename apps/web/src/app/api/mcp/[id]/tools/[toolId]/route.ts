import { getDatabase, getMcpServerForUser, updateMcpToolForUser, writeAuditLog } from "@aiw/database";
import { updateMcpToolSchema } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { toMcpToolDto } from "@/server/mcp";
import { requireApiSession } from "@/server/session";

/** PATCH /api/mcp/:id/tools/:toolId — enable/disable a tool or override its permission level. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/mcp/[id]/tools/[toolId]">): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const { id, toolId } = await ctx.params;
    if (!isUuid(id) || !isUuid(toolId)) throw new HttpError(404, "not_found", "Tool not found.");
    const changes = await readJson(request, updateMcpToolSchema);
    const db = getDatabase();
    const server = await getMcpServerForUser(db, user.id, id);
    if (!server) throw new HttpError(404, "not_found", "Tool not found.");
    const updated = await updateMcpToolForUser(db, user.id, id, toolId, changes);
    if (!updated) throw new HttpError(404, "not_found", "Tool not found.");
    await writeAuditLog(db, {
      userId: user.id,
      action: "mcp_tool.updated",
      resourceType: "mcp_tool",
      resourceId: toolId,
      metadata: { server: server.slug, tool: updated.name, ...changes },
    });
    return Response.json(toMcpToolDto(server, updated));
  } catch (error) {
    return errorResponse(error);
  }
}
