import { createMcpServer, getDatabase, listMcpServersForUser, writeAuditLog } from "@aiw/database";
import { refreshMcpServer } from "@aiw/mcp";
import { createMcpServerSchema, type McpRefreshResultDto } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import {
  assertMcpRefreshAllowed,
  assertStdioAllowed,
  getMcpCapabilities,
  getMcpServices,
  loadMcpServerWithTools,
  toMcpServerDto,
} from "@/server/mcp";
import { requireApiSession } from "@/server/session";

/** GET /api/mcp — the user's MCP servers and what this server allows. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const servers = await listMcpServersForUser(getDatabase(), user.id);
    return Response.json({ servers: servers.map(toMcpServerDto), capabilities: getMcpCapabilities(user) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/mcp — add a server, then test the connection and discover its tools. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const input = await readJson(request, createMcpServerSchema);
    if (input.transport === "stdio") assertStdioAllowed(user);
    assertMcpRefreshAllowed(user.id);

    const services = getMcpServices();
    const db = getDatabase();
    const created = await createMcpServer(db, {
      ownerId: user.id,
      slug: input.slug,
      name: input.name,
      description: input.description,
      transport: input.transport,
      enabled: input.enabled,
      timeoutSeconds: input.timeoutSeconds,
      ...(input.transport === "stdio"
        ? { command: input.command, args: input.args, env: services.secrets.encryptMap(input.env) }
        : { url: input.url, headers: services.secrets.encryptMap(input.headers) }),
    });
    if (!created) throw new HttpError(409, "conflict", `You already have an MCP server named "${input.slug}".`);
    await writeAuditLog(db, {
      userId: user.id,
      action: "mcp_server.created",
      resourceType: "mcp_server",
      resourceId: created.id,
      metadata: { slug: created.slug, transport: created.transport },
    });

    const result = await refreshMcpServer(services, created);
    const server = await loadMcpServerWithTools(user.id, created.id);
    if (!server) throw new HttpError(404, "not_found", "MCP server not found.");
    const body: McpRefreshResultDto = { server, ...result };
    return Response.json(body, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
