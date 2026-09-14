import { z } from "zod";
import type { ToolPermissionLevel } from "./tools";

export const MCP_TRANSPORTS = ["stdio", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_PERMISSION_LEVELS = ["READ", "WRITE", "EXECUTE", "NETWORK", "DESTRUCTIVE"] as const satisfies readonly ToolPermissionLevel[];

/** Prefixes used by built-in and planned tools; an MCP server slug cannot take them. */
export const RESERVED_MCP_SLUGS = ["files", "git", "terminal", "web", "browser", "computer", "mcp", "memory", "system", "agent", "approval"] as const;

export const MCP_LIMITS = {
  timeoutSeconds: { min: 1, max: 600 },
  maxArgs: 64,
  maxHeaders: 20,
  maxEnv: 50,
} as const;

const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

export const mcpSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,31}$/, "Use 2–32 lowercase letters, digits or underscores, starting with a letter.")
  .refine((slug) => !(RESERVED_MCP_SLUGS as readonly string[]).includes(slug), "This name is reserved for built-in tools.");

const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid header name.")
  .refine((name) => !FORBIDDEN_HEADERS.has(name.toLowerCase()), "This header is managed by the MCP client.");
const headerValueSchema = z
  .string()
  .max(8192)
  .regex(/^[^\r\n\0]*$/, "Header values cannot contain line breaks.");
const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Invalid environment variable name.");
const envValueSchema = z.string().max(32_768).regex(/^[^\0]*$/, "Environment values cannot contain null bytes.");

const maxEntries = (max: number) => (record: Record<string, unknown>) => Object.keys(record).length <= max;
const tooMany = (what: string) => `Too many ${what}.`;

const httpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Enter an http(s) URL without credentials.");

const baseServerFields = {
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(""),
  enabled: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(MCP_LIMITS.timeoutSeconds.min).max(MCP_LIMITS.timeoutSeconds.max).default(60),
};

const stdioFields = {
  command: z.string().trim().min(1).max(512),
  args: z.array(z.string().max(2000)).max(MCP_LIMITS.maxArgs).default([]),
};

export const createMcpServerSchema = z.discriminatedUnion("transport", [
  z.object({
    ...baseServerFields,
    slug: mcpSlugSchema,
    transport: z.literal("stdio"),
    ...stdioFields,
    env: z.record(envNameSchema, envValueSchema).refine(maxEntries(MCP_LIMITS.maxEnv), tooMany("environment variables")).default({}),
  }),
  z.object({
    ...baseServerFields,
    slug: mcpSlugSchema,
    transport: z.literal("http"),
    url: httpUrlSchema,
    headers: z.record(headerNameSchema, headerValueSchema).refine(maxEntries(MCP_LIMITS.maxHeaders), tooMany("headers")).default({}),
  }),
]);
export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;

/**
 * Secret maps are write-only: a value replaces the stored secret, `null`
 * removes it, and names left out keep their current value. The slug and
 * transport cannot change, so assigned tool names stay stable.
 */
export const updateMcpServerSchema = z
  .object({
    name: baseServerFields.name,
    description: z.string().trim().max(500),
    enabled: z.boolean(),
    timeoutSeconds: baseServerFields.timeoutSeconds.unwrap(),
    command: stdioFields.command,
    args: stdioFields.args.unwrap(),
    url: httpUrlSchema,
    env: z.record(envNameSchema, envValueSchema.nullable()).refine(maxEntries(MCP_LIMITS.maxEnv), tooMany("environment variables")),
    headers: z.record(headerNameSchema, headerValueSchema.nullable()).refine(maxEntries(MCP_LIMITS.maxHeaders), tooMany("headers")),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;

export const updateMcpToolSchema = z
  .object({
    enabled: z.boolean(),
    /** null = use the level derived from the server's annotations. */
    permission: z.enum(MCP_PERMISSION_LEVELS).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });
export type UpdateMcpToolInput = z.infer<typeof updateMcpToolSchema>;

export type McpServerStatus = "unknown" | "connected" | "error";

export interface McpServerDto {
  id: string;
  slug: string;
  name: string;
  description: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /** Names only; values are never sent to the browser. */
  headerNames: string[];
  envNames: string[];
  enabled: boolean;
  timeoutSeconds: number;
  status: McpServerStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  serverName: string | null;
  serverVersion: string | null;
  toolsRefreshedAt: string | null;
  toolCount: number;
  enabledToolCount: number;
  available: boolean;
  unavailableReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpToolAnnotationsDto {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDto {
  id: string;
  serverId: string;
  name: string;
  /** Name agents are assigned and models call: `<server slug>.<tool name>`. */
  qualifiedName: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotationsDto | null;
  /** Derived from the server's annotations (hints, not guarantees). */
  defaultPermission: ToolPermissionLevel;
  /** User override, or null. */
  permission: ToolPermissionLevel | null;
  effectivePermission: ToolPermissionLevel;
  enabled: boolean;
}

export interface McpServerWithToolsDto extends McpServerDto {
  tools: McpToolDto[];
}

export interface McpRefreshResultDto {
  server: McpServerWithToolsDto;
  ok: boolean;
  error: string | null;
  added: number;
  updated: number;
  removed: number;
  /** Tools ignored because of invalid names or unsupported schemas. */
  skipped: number;
}

/** Server-wide MCP capabilities shown in the UI. */
export interface McpCapabilitiesDto {
  stdioEnabled: boolean;
  /** stdio servers run commands on the host, so only administrators can add them. */
  canUseStdio: boolean;
  allowPrivateNetwork: boolean;
}
