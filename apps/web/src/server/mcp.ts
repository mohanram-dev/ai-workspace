import {
  getDatabase,
  getMcpServerForUser,
  listMcpToolsForServer,
  listMcpToolsForUser,
  type McpServer,
  type McpServerWithCounts,
  type McpTool,
} from "@aiw/database";
import { mcpServerAvailability, mcpToolAvailability, qualifiedToolName } from "@aiw/mcp";
import type { McpCapabilitiesDto, McpServerDto, McpServerWithToolsDto, McpToolDto, ToolInfoDto, ToolPermissionLevel } from "@aiw/shared";
import type { AuthSession } from "./auth";
import { getServerEnv } from "@aiw/runtime";
import { HttpError } from "./http";
import { FixedWindowRateLimiter } from "./rate-limit";


export { getMcpServices, type McpRuntime } from "@aiw/runtime";

export function getMcpCapabilities(user: AuthSession["user"]): McpCapabilitiesDto {
  const env = getServerEnv();
  return {
    stdioEnabled: env.MCP_STDIO_ENABLED,
    canUseStdio: env.MCP_STDIO_ENABLED && isAdmin(user),
    allowPrivateNetwork: env.MCP_ALLOW_PRIVATE_NETWORK,
  };
}

export function isAdmin(user: AuthSession["user"]): boolean {
  return (user as { role?: string }).role === "admin";
}

export function toMcpServerDto(row: McpServerWithCounts): McpServerDto {
  const availability = mcpServerAvailability(row, getServerEnv().MCP_STDIO_ENABLED);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    headerNames: Object.keys(row.headers).sort(),
    envNames: Object.keys(row.env).sort(),
    enabled: row.enabled,
    timeoutSeconds: row.timeoutSeconds,
    status: row.status,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    serverName: row.serverName,
    serverVersion: row.serverVersion,
    toolsRefreshedAt: row.toolsRefreshedAt?.toISOString() ?? null,
    toolCount: row.toolCount,
    enabledToolCount: row.enabledToolCount,
    available: availability.available,
    unavailableReason: availability.available ? null : (availability.reason ?? "Unavailable."),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMcpToolDto(server: Pick<McpServer, "slug">, row: McpTool): McpToolDto {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    qualifiedName: qualifiedToolName(server, row.name),
    title: row.title,
    description: row.description,
    inputSchema: row.inputSchema,
    annotations: row.annotations,
    defaultPermission: row.defaultPermission as ToolPermissionLevel,
    permission: row.permission as ToolPermissionLevel | null,
    effectivePermission: (row.permission ?? row.defaultPermission) as ToolPermissionLevel,
    enabled: row.enabled,
  };
}

export async function loadMcpServerWithTools(ownerId: string, serverId: string): Promise<McpServerWithToolsDto | null> {
  const db = getDatabase();
  const server = await getMcpServerForUser(db, ownerId, serverId);
  if (!server) return null;
  const tools = await listMcpToolsForServer(db, server.id);
  return { ...toMcpServerDto(server), tools: tools.map((t) => toMcpToolDto(server, t)) };
}

/** The user's MCP tools in the shape of the built-in tool list (agent editor, /api/tools). */
export async function describeMcpToolsForUser(ownerId: string): Promise<ToolInfoDto[]> {
  const stdioEnabled = getServerEnv().MCP_STDIO_ENABLED;
  const rows = await listMcpToolsForUser(getDatabase(), ownerId);
  return rows.map(({ tool, server }) => {
    const availability = mcpToolAvailability(server, tool, stdioEnabled);
    return {
      name: qualifiedToolName(server, tool.name),
      description: tool.description || tool.title || tool.name,
      category: "mcp" as const,
      permission: (tool.permission ?? tool.defaultPermission) as ToolPermissionLevel,
      available: availability.available,
      unavailableReason: availability.available ? null : (availability.reason ?? "Unavailable."),
      server: { id: server.id, name: server.name, slug: server.slug },
    };
  });
}

const globalForMcpLimits = globalThis as unknown as { __aiwMcpRefreshLimiter?: FixedWindowRateLimiter };

/** Connection tests start processes or open network connections; limit them per user. */
export function assertMcpRefreshAllowed(userId: string): void {
  globalForMcpLimits.__aiwMcpRefreshLimiter ??= new FixedWindowRateLimiter(10, 60_000);
  const result = globalForMcpLimits.__aiwMcpRefreshLimiter.check(userId);
  if (!result.allowed) {
    throw new HttpError(429, "rate_limited", "Too many MCP connection tests. Try again shortly.", undefined, {
      "Retry-After": String(result.retryAfterSeconds),
    });
  }
}

/** stdio servers execute a command on this host: administrators only, and only when enabled. */
export function assertStdioAllowed(user: AuthSession["user"]): void {
  if (!getServerEnv().MCP_STDIO_ENABLED) {
    throw new HttpError(403, "forbidden", "stdio MCP servers are disabled on this server. Set MCP_STDIO_ENABLED=true to allow them.");
  }
  if (!isAdmin(user)) throw new HttpError(403, "forbidden", "Only administrators can configure stdio MCP servers, because they run commands on the host.");
}
