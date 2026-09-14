import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agents, mcpServers, mcpTools } from "../schema";

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
export type McpTool = typeof mcpTools.$inferSelect;

export interface McpServerWithCounts extends McpServer {
  toolCount: number;
  enabledToolCount: number;
}

export interface DiscoveredMcpTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpTool["annotations"];
  defaultPermission: string;
}

// Table-qualified on purpose: Drizzle renders bare column names inside raw subqueries.
const toolCounts = {
  toolCount: sql<number>`(select count(*)::int from mcp_tool t where t.server_id = mcp_server.id)`.mapWith(Number),
  enabledToolCount: sql<number>`(select count(*)::int from mcp_tool t where t.server_id = mcp_server.id and t.enabled)`.mapWith(Number),
};

export async function listMcpServersForUser(db: Database, ownerId: string): Promise<McpServerWithCounts[]> {
  const rows = await db
    .select({ server: mcpServers, ...toolCounts })
    .from(mcpServers)
    .where(eq(mcpServers.ownerId, ownerId))
    .orderBy(asc(mcpServers.name), asc(mcpServers.createdAt));
  return rows.map((r) => ({ ...r.server, toolCount: r.toolCount, enabledToolCount: r.enabledToolCount }));
}

export async function getMcpServerForUser(db: Database, ownerId: string, serverId: string): Promise<McpServerWithCounts | null> {
  const [row] = await db
    .select({ server: mcpServers, ...toolCounts })
    .from(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.ownerId, ownerId)))
    .limit(1);
  return row ? { ...row.server, toolCount: row.toolCount, enabledToolCount: row.enabledToolCount } : null;
}

/** Returns null when the slug is already used by this owner. */
export async function createMcpServer(db: Database, values: NewMcpServer): Promise<McpServer | null> {
  const [row] = await db
    .insert(mcpServers)
    .values(values)
    .onConflictDoNothing({ target: [mcpServers.ownerId, mcpServers.slug] })
    .returning();
  return row ?? null;
}

export async function updateMcpServerForUser(
  db: Database,
  ownerId: string,
  serverId: string,
  changes: Partial<Omit<NewMcpServer, "id" | "ownerId" | "slug" | "transport" | "createdAt">>,
): Promise<McpServer | null> {
  const [row] = await db
    .update(mcpServers)
    .set(changes)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.ownerId, ownerId)))
    .returning();
  return row ?? null;
}

/** Deletes the server and its tools, and unassigns those tools from the owner's agents. */
export async function deleteMcpServerForUser(db: Database, ownerId: string, serverId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [server] = await tx
      .delete(mcpServers)
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.ownerId, ownerId)))
      .returning({ slug: mcpServers.slug });
    if (!server) return false;
    await tx
      .update(agents)
      .set({ tools: sql`coalesce((select array_agg(t) from unnest(${agents.tools}) as t where not starts_with(t, ${`${server.slug}.`})), '{}'::text[])` })
      .where(and(eq(agents.ownerId, ownerId), sql`exists (select 1 from unnest(${agents.tools}) as t where starts_with(t, ${`${server.slug}.`}))`));
    return true;
  });
}

export async function listMcpToolsForServer(db: Database, serverId: string): Promise<McpTool[]> {
  return db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)).orderBy(asc(mcpTools.name));
}

/** Every tool of the owner's servers, with its server. */
export async function listMcpToolsForUser(db: Database, ownerId: string): Promise<{ tool: McpTool; server: McpServer }[]> {
  return db
    .select({ tool: mcpTools, server: mcpServers })
    .from(mcpTools)
    .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
    .where(eq(mcpTools.ownerId, ownerId))
    .orderBy(asc(mcpServers.name), asc(mcpTools.name));
}

/**
 * Stores the result of tool discovery: new tools are inserted, existing ones
 * refreshed (keeping the user's enablement and permission override), and tools
 * the server no longer offers are deleted and unassigned from agents.
 */
export async function syncMcpTools(
  db: Database,
  server: Pick<McpServer, "id" | "ownerId" | "slug">,
  discovered: DiscoveredMcpTool[],
): Promise<{ added: number; updated: number; removed: number }> {
  return db.transaction(async (tx) => {
    const existing = await tx.select({ name: mcpTools.name }).from(mcpTools).where(eq(mcpTools.serverId, server.id));
    const existingNames = new Set(existing.map((e) => e.name));
    const names = discovered.map((t) => t.name);

    const removed = names.length
      ? await tx
          .delete(mcpTools)
          .where(and(eq(mcpTools.serverId, server.id), notInArray(mcpTools.name, names)))
          .returning({ name: mcpTools.name })
      : await tx.delete(mcpTools).where(eq(mcpTools.serverId, server.id)).returning({ name: mcpTools.name });

    if (discovered.length > 0) {
      await tx
        .insert(mcpTools)
        .values(discovered.map((t) => ({ ...t, serverId: server.id, ownerId: server.ownerId })))
        .onConflictDoUpdate({
          target: [mcpTools.serverId, mcpTools.name],
          set: {
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            inputSchema: sql`excluded.input_schema`,
            annotations: sql`excluded.annotations`,
            defaultPermission: sql`excluded.default_permission`,
            updatedAt: new Date(),
          },
        });
    }

    if (removed.length > 0) {
      const qualified = removed.map((r) => `${server.slug}.${r.name}`);
      await unassignTools(tx as unknown as Database, server.ownerId, qualified);
    }
    const added = names.filter((n) => !existingNames.has(n)).length;
    return { added, updated: names.length - added, removed: removed.length };
  });
}

async function unassignTools(db: Database, ownerId: string, toolNames: string[]): Promise<void> {
  const list = sql`array[${sql.join(
    toolNames.map((n) => sql`${n}`),
    sql`, `,
  )}]::text[]`;
  await db
    .update(agents)
    .set({ tools: sql`coalesce((select array_agg(t) from unnest(${agents.tools}) as t where t <> all(${list})), '{}'::text[])` })
    .where(and(eq(agents.ownerId, ownerId), sql`${agents.tools} && ${list}`));
}

export async function updateMcpToolForUser(
  db: Database,
  ownerId: string,
  serverId: string,
  toolId: string,
  changes: { enabled?: boolean; permission?: string | null },
): Promise<McpTool | null> {
  const [row] = await db
    .update(mcpTools)
    .set(changes)
    .where(and(eq(mcpTools.id, toolId), eq(mcpTools.serverId, serverId), eq(mcpTools.ownerId, ownerId)))
    .returning();
  return row ?? null;
}

/** Owner's tools by qualified name (`<slug>.<tool>`), for validating agent assignments. */
export async function listMcpToolNamesForUser(db: Database, ownerId: string, qualifiedNames?: string[]): Promise<string[]> {
  const rows = await db
    .select({ slug: mcpServers.slug, name: mcpTools.name })
    .from(mcpTools)
    .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
    .where(
      and(
        eq(mcpTools.ownerId, ownerId),
        qualifiedNames?.length ? inArray(sql`${mcpServers.slug} || '.' || ${mcpTools.name}`, qualifiedNames) : undefined,
      ),
    );
  return rows.map((r) => `${r.slug}.${r.name}`);
}
