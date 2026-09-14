import { deleteMcpServerForUser, getDatabase, getMcpServerForUser, updateMcpServerForUser, writeAuditLog } from "@aiw/database";
import { updateMcpServerSchema } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { assertStdioAllowed, getMcpServices, loadMcpServerWithTools } from "@/server/mcp";
import { requireApiSession } from "@/server/session";

type Context = RouteContext<"/api/mcp/[id]">;

async function serverId(ctx: Context): Promise<string> {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, "not_found", "MCP server not found.");
  return id;
}

/** GET /api/mcp/:id — server with its discovered tools. Secret values are never returned. */
export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const server = await loadMcpServerWithTools(user.id, await serverId(ctx));
    if (!server) throw new HttpError(404, "not_found", "MCP server not found.");
    return Response.json(server);
  } catch (error) {
    return errorResponse(error);
  }
}

/** PATCH /api/mcp/:id — update settings. Changing the connection closes the open connection. */
export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await serverId(ctx);
    const changes = await readJson(request, updateMcpServerSchema);
    const db = getDatabase();
    const existing = await getMcpServerForUser(db, user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "MCP server not found.");

    const stdioChanges = changes.command !== undefined || changes.args !== undefined || changes.env !== undefined;
    const httpChanges = changes.url !== undefined || changes.headers !== undefined;
    if (existing.transport === "http" && stdioChanges) throw new HttpError(400, "bad_request", "command, args and env apply to stdio servers only.");
    if (existing.transport === "stdio" && httpChanges) throw new HttpError(400, "bad_request", "url and headers apply to http servers only.");
    if (existing.transport === "stdio" && stdioChanges) assertStdioAllowed(user);

    const { secrets, manager } = getMcpServices();
    const updated = await updateMcpServerForUser(db, user.id, id, {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
      ...(changes.timeoutSeconds !== undefined ? { timeoutSeconds: changes.timeoutSeconds } : {}),
      ...(changes.command !== undefined ? { command: changes.command } : {}),
      ...(changes.args !== undefined ? { args: changes.args } : {}),
      ...(changes.url !== undefined ? { url: changes.url } : {}),
      ...(changes.env !== undefined ? { env: secrets.applyUpdate(existing.env, changes.env) } : {}),
      ...(changes.headers !== undefined ? { headers: secrets.applyUpdate(existing.headers, changes.headers) } : {}),
      ...(stdioChanges || httpChanges ? { status: "unknown" as const, lastError: null } : {}),
    });
    if (!updated) throw new HttpError(404, "not_found", "MCP server not found.");
    if (stdioChanges || httpChanges || changes.enabled === false) await manager.close(id);

    await writeAuditLog(db, {
      userId: user.id,
      action: "mcp_server.updated",
      resourceType: "mcp_server",
      resourceId: id,
      // Field names only: secret values and their names' contents stay out of the audit log.
      metadata: { fields: Object.keys(changes) },
    });
    return Response.json(await loadMcpServerWithTools(user.id, id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/mcp/:id — remove the server and unassign its tools from agents. */
export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await serverId(ctx);
    const db = getDatabase();
    const existing = await getMcpServerForUser(db, user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "MCP server not found.");
    await getMcpServices().manager.close(id);
    await deleteMcpServerForUser(db, user.id, id);
    await writeAuditLog(db, {
      userId: user.id,
      action: "mcp_server.deleted",
      resourceType: "mcp_server",
      resourceId: id,
      metadata: { slug: existing.slug },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
