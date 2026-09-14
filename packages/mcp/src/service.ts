import { z } from "zod";
import {
  listMcpToolsForUser,
  syncMcpTools,
  updateMcpServerForUser,
  type Database,
  type DiscoveredMcpTool,
  type McpServer,
  type McpTool,
} from "@aiw/database";
import { isToolError, ToolError, Workspace, type AnyToolDefinition, type ToolAvailability, type ToolSource } from "@aiw/tools";
import type { McpConnectionConfig, McpConnectionManager } from "./client";
import { defaultPermissionFor, effectivePermission, pickAnnotations } from "./permissions";
import { clip, convertToolResult } from "./results";
import type { SecretBox } from "./secrets";

export interface McpServices {
  db: Database;
  manager: McpConnectionManager;
  secrets: SecretBox;
  /** Base directory for per-user workspaces; stdio servers start in the owner's workspace. */
  workspaceRoot?: string;
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_SCHEMA_CHARS = 50_000;
const MAX_DESCRIPTION_CHARS = 2000;

export function qualifiedToolName(server: Pick<McpServer, "slug">, toolName: string): string {
  return `${server.slug}.${toolName}`;
}

export function mcpServerAvailability(server: Pick<McpServer, "enabled" | "transport">, stdioEnabled: boolean): ToolAvailability {
  if (!server.enabled) return { available: false, reason: "The MCP server is disabled." };
  if (server.transport === "stdio" && !stdioEnabled) {
    return { available: false, reason: "stdio MCP servers are disabled on this server (MCP_STDIO_ENABLED=false)." };
  }
  return { available: true };
}

export function mcpToolAvailability(server: McpServer, tool: Pick<McpTool, "enabled">, stdioEnabled: boolean): ToolAvailability {
  const serverAvailability = mcpServerAvailability(server, stdioEnabled);
  if (!serverAvailability.available) return serverAvailability;
  if (!tool.enabled) return { available: false, reason: "The tool is disabled for this MCP server." };
  return { available: true };
}

/** Connection settings with secrets decrypted. Throws ToolError when secrets cannot be read. */
export function connectionConfig(services: McpServices, server: McpServer): McpConnectionConfig {
  let headers: Record<string, string>;
  let env: Record<string, string>;
  try {
    headers = services.secrets.decryptMap(server.headers);
    env = services.secrets.decryptMap(server.env);
  } catch (error) {
    if ((error as Error)?.name === "SecretDecryptionError") throw new ToolError("unavailable", `MCP server "${server.name}": ${(error as Error).message}`);
    throw error;
  }
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    headers,
    env,
    ...(services.workspaceRoot && server.transport === "stdio"
      ? { cwd: Workspace.forUser(services.workspaceRoot, server.ownerId).root }
      : {}),
  };
}

export interface RefreshResult {
  ok: boolean;
  error: string | null;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
}

/**
 * Tests the connection with the current configuration and stores the tools
 * the server offers. Connection failures are recorded on the server, not thrown.
 */
export async function refreshMcpServer(services: McpServices, server: McpServer): Promise<RefreshResult> {
  const { db, manager } = services;
  const empty = { added: 0, updated: 0, removed: 0, skipped: 0 };
  const availability = mcpServerAvailability({ ...server, enabled: true }, manager.stdioEnabled);
  if (!availability.available) {
    await updateMcpServerForUser(db, server.ownerId, server.id, { status: "error", lastError: availability.reason ?? null, lastCheckedAt: new Date() });
    return { ok: false, error: availability.reason ?? "Unavailable.", ...empty };
  }

  try {
    // Always test the saved configuration with a fresh connection.
    await manager.close(server.id);
    const { tools, server: info } = await manager.listTools(connectionConfig(services, server));
    const discovered: DiscoveredMcpTool[] = [];
    let skipped = 0;
    for (const tool of tools) {
      const schema = normaliseSchema(tool.inputSchema);
      if (!TOOL_NAME_PATTERN.test(tool.name) || !schema) {
        skipped++;
        continue;
      }
      const annotations = pickAnnotations(tool.annotations);
      discovered.push({
        name: tool.name,
        title: typeof tool.title === "string" ? tool.title.slice(0, 200) : (annotations?.title ?? null),
        description: clip(tool.description ?? "", MAX_DESCRIPTION_CHARS),
        inputSchema: schema,
        annotations,
        defaultPermission: defaultPermissionFor(annotations),
      });
    }
    const counts = await syncMcpTools(db, server, discovered);
    const now = new Date();
    await updateMcpServerForUser(db, server.ownerId, server.id, {
      status: "connected",
      lastError: null,
      lastCheckedAt: now,
      toolsRefreshedAt: now,
      serverName: info.name?.slice(0, 200) ?? null,
      serverVersion: info.version?.slice(0, 100) ?? null,
    });
    return { ok: true, error: null, ...counts, skipped };
  } catch (error) {
    const message = isToolError(error) ? error.message : "The MCP server could not be reached.";
    if (!isToolError(error)) console.error(`MCP refresh failed for server ${server.id}`, error);
    await updateMcpServerForUser(db, server.ownerId, server.id, { status: "error", lastError: message, lastCheckedAt: new Date() });
    return { ok: false, error: message, ...empty };
  }
}

/** JSON Schema for the model: an object schema without draft metadata, bounded in size. */
function normaliseSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const copy = { ...(schema as Record<string, unknown>) };
  delete copy.$schema;
  if (copy.type === undefined) copy.type = "object";
  if (copy.type !== "object") return null;
  if (JSON.stringify(copy).length > MAX_SCHEMA_CHARS) return null;
  return copy;
}

// Arguments are validated by the MCP server against its own schema; locally we only require an object.
const argumentsSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .transform((value) => value ?? {});

/** Tools from the user's MCP servers, as regular tool definitions for the agent runtime. */
export class McpToolSource implements ToolSource {
  constructor(private readonly services: McpServices) {}

  async toolsForUser(userId: string): Promise<AnyToolDefinition[]> {
    const rows = await listMcpToolsForUser(this.services.db, userId);
    return rows.map(({ tool, server }) => this.definition(server, tool));
  }

  private definition(server: McpServer, tool: McpTool): AnyToolDefinition {
    const { manager } = this.services;
    const qualifiedName = qualifiedToolName(server, tool.name);
    const timeoutMs = server.timeoutSeconds * 1000;
    return {
      name: qualifiedName,
      description: clip(`[MCP: ${server.name}] ${tool.title && tool.title !== tool.name ? `${tool.title}. ` : ""}${tool.description}`.trim(), 1024),
      category: "mcp",
      inputSchema: argumentsSchema,
      parameters: tool.inputSchema,
      permission: effectivePermission(tool),
      timeoutMs,
      availability: () => mcpToolAvailability(server, tool, manager.stdioEnabled),
      execute: async (input: Record<string, unknown>, context) => {
        const base = { serverId: server.id, serverName: server.name, tool: tool.name };
        const started = performance.now();
        context.report({ type: "MCP_TOOL_STARTED", ...base });
        let converted;
        try {
          const result = await manager.callTool(connectionConfig(this.services, server), tool.name, input, { signal: context.signal, timeoutMs });
          converted = convertToolResult(result);
        } catch (error) {
          context.report({ type: "MCP_TOOL_FINISHED", ...base, isError: true, durationMs: Math.round(performance.now() - started) });
          throw error;
        }
        context.report({ type: "MCP_TOOL_FINISHED", ...base, isError: converted.isError, durationMs: Math.round(performance.now() - started) });

        if (converted.isError) {
          throw new ToolError("failed", `The MCP tool reported an error: ${clip(converted.text || "no details", 2000)}`);
        }
        const firstLine = converted.text.split("\n").find((line) => line.trim())?.trim();
        return {
          output: converted.output,
          summary: firstLine ? `${server.name} · ${tool.name}: ${clip(firstLine, 140)}` : `${server.name} · ${tool.name} returned no content`,
          content: converted.text || "(The tool returned no content.)",
        };
      },
    };
  }
}
