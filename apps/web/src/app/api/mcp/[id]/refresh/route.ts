import { getDatabase, getMcpServerForUser, writeAuditLog } from "@aiw/database";
import { refreshMcpServer } from "@aiw/mcp";
import type { McpRefreshResultDto } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid } from "@/server/http";
import { assertMcpRefreshAllowed, assertStdioAllowed, getMcpServices, loadMcpServerWithTools } from "@/server/mcp";
import { requireApiSession } from "@/server/session";

/** POST /api/mcp/:id/refresh — test the connection and re-discover tools. Failures are part of the result. */
export async function POST(request: Request, ctx: RouteContext<"/api/mcp/[id]/refresh">): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "MCP server not found.");
    const db = getDatabase();
    const existing = await getMcpServerForUser(db, user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "MCP server not found.");
    if (existing.transport === "stdio") assertStdioAllowed(user);
    assertMcpRefreshAllowed(user.id);

    const result = await refreshMcpServer(getMcpServices(), existing);
    await writeAuditLog(db, {
      userId: user.id,
      action: "mcp_server.refreshed",
      resourceType: "mcp_server",
      resourceId: id,
      metadata: { ok: result.ok, added: result.added, removed: result.removed },
    });
    const server = await loadMcpServerWithTools(user.id, id);
    if (!server) throw new HttpError(404, "not_found", "MCP server not found.");
    const body: McpRefreshResultDto = { server, ...result };
    return Response.json(body);
  } catch (error) {
    return errorResponse(error);
  }
}
