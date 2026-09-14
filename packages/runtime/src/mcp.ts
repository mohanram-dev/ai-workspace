import { getDatabase } from "@aiw/database";
import { McpConnectionManager, McpToolSource, SecretBox, type McpServices } from "@aiw/mcp";
import { getServerEnv } from "./env";
import { getWorkspaceRoot } from "./tools";

export interface McpRuntime extends McpServices {
  source: McpToolSource;
}

const globalForMcp = globalThis as unknown as { __aiwMcp?: McpRuntime };

/** Process-wide MCP connection manager, secret box and tool source (kept across dev hot reloads). */
export function getMcpServices(): McpRuntime {
  if (!globalForMcp.__aiwMcp) {
    const env = getServerEnv();
    const services: McpServices = {
      db: getDatabase(),
      manager: new McpConnectionManager({ stdioEnabled: env.MCP_STDIO_ENABLED, allowPrivateNetwork: env.MCP_ALLOW_PRIVATE_NETWORK }),
      secrets: new SecretBox(env.BETTER_AUTH_SECRET),
      workspaceRoot: getWorkspaceRoot(),
    };
    globalForMcp.__aiwMcp = { ...services, source: new McpToolSource(services) };
  }
  return globalForMcp.__aiwMcp;
}
