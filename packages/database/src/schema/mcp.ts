import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { McpToolAnnotationsDto } from "@aiw/shared";
import { users } from "./auth";

export const mcpTransport = pgEnum("mcp_transport", ["stdio", "http"]);
export const mcpServerStatus = pgEnum("mcp_server_status", ["unknown", "connected", "error"]);

/** A user's MCP server. Header and environment values are encrypted at rest; names are stored in clear. */
export const mcpServers = pgTable(
  "mcp_server",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Tool name prefix (`<slug>.<tool>`). Immutable after creation. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    transport: mcpTransport("transport").notNull(),
    command: text("command"),
    args: text("args").array().notNull().default(sql`'{}'::text[]`),
    url: text("url"),
    /** Header name → encrypted value. */
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    /** Environment variable name → encrypted value (stdio only). */
    env: jsonb("env").$type<Record<string, string>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    timeoutSeconds: integer("timeout_seconds").notNull().default(60),
    status: mcpServerStatus("status").notNull().default("unknown"),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    serverName: text("server_name"),
    serverVersion: text("server_version"),
    toolsRefreshedAt: timestamp("tools_refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("mcp_server_owner_slug_idx").on(t.ownerId, t.slug)],
);

/** A tool discovered on an MCP server, with the user's enablement and permission override. */
export const mcpTools = pgTable(
  "mcp_tool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title"),
    description: text("description").notNull().default(""),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    annotations: jsonb("annotations").$type<McpToolAnnotationsDto | null>(),
    /** Level derived from annotations at discovery. */
    defaultPermission: text("default_permission").notNull(),
    /** User override; null uses the default. */
    permission: text("permission"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("mcp_tool_server_name_idx").on(t.serverId, t.name), index("mcp_tool_owner_idx").on(t.ownerId)],
);
