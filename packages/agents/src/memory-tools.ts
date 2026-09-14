import { z } from "zod";
import { forgetMemory, getTask, listMemories, rememberMemory, type Database, type MemoryTarget } from "@aiw/database";
import { join } from "node:path";
import { ToolError, Workspace, type AnyToolDefinition, type ToolDefinition } from "@aiw/tools";

/** Scope of a memory call, resolved from the task (agent, and project when the task has one). */
export interface MemoryContext {
  userId: string;
  agentId: string | null;
  projectId: string | null;
  taskId: string;
}

const TOOL_TIMEOUT_MS = 10_000;
const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\n\r]+$/, "The key must be a single line.");

function target(context: MemoryContext, scope: "project" | "agent"): MemoryTarget {
  if (scope === "project") {
    if (!context.projectId) throw new ToolError("invalid_input", "This task is not in a project, so there is no project memory. Use scope \"agent\".");
    return { scope: "project", projectId: context.projectId };
  }
  if (!context.agentId) throw new ToolError("unavailable", "This task has no agent, so there is no agent memory.");
  return { scope: "agent", agentId: context.agentId };
}

/**
 * Memory tools (spec §25): short structured facts the agent chooses to keep,
 * not a transcript. Project scope is shared by everything in the project;
 * agent scope follows the agent across tasks.
 */
export function createMemoryTools(db: Database): AnyToolDefinition[] {
  // The scope comes from the task itself: its agent, and its project when it has one.
  const resolve = async (taskId: string): Promise<MemoryContext> => {
    const task = await getTask(db, taskId);
    if (!task) throw new ToolError("unavailable", "Memory is not available for this task.");
    return { userId: task.userId, agentId: task.agentId, projectId: task.projectId, taskId: task.id };
  };

  const tools: AnyToolDefinition[] = [
    {
      name: "memory.remember",
      description:
        "Remember one short fact for later tasks, as a key and a value (for example key \"database\", value \"PostgreSQL 17\"). Writing the same key again replaces it. Use it for durable facts the user confirmed, never for whole messages or secrets.",
      category: "memory",
      inputSchema: z.object({
        key: keySchema,
        value: z.string().trim().min(1).max(2000),
        scope: z.enum(["project", "agent"]).default("project"),
      }),
      permission: "WRITE",
      timeoutMs: TOOL_TIMEOUT_MS,
      availability: () => ({ available: true }),
      execute: async (input: { key: string; value: string; scope: "project" | "agent" }, toolContext) => {
        const context = await resolve(toolContext.taskId);
        const scope = input.scope === "project" && !context.projectId ? "agent" : input.scope;
        const row = await rememberMemory(db, {
          userId: context.userId,
          ...target(context, scope),
          key: input.key,
          value: input.value,
          source: "agent",
          taskId: context.taskId,
        });
        return {
          output: { id: row.id, scope: row.scope, key: row.key, value: row.value },
          summary: `Remembered ${row.key} (${row.scope} memory)`,
          content: `Stored in ${row.scope} memory: ${row.key} = ${row.value}`,
        };
      },
    },
    {
      name: "memory.list",
      description: "List what you remember for this project and agent.",
      category: "memory",
      inputSchema: z.object({ scope: z.enum(["project", "agent"]).default("project") }),
      permission: "READ",
      timeoutMs: TOOL_TIMEOUT_MS,
      availability: () => ({ available: true }),
      execute: async (input: { scope: "project" | "agent" }, toolContext) => {
        const context = await resolve(toolContext.taskId);
        const scope = input.scope === "project" && !context.projectId ? "agent" : input.scope;
        const rows = await listMemories(db, context.userId, target(context, scope));
        return {
          output: { scope, memories: rows.map((r) => ({ key: r.key, value: r.value })) },
          summary: `Read ${rows.length} ${scope} memories`,
          content: rows.length ? rows.map((r) => `- ${r.key}: ${r.value}`).join("\n") : `No ${scope} memories yet.`,
        };
      },
    },
    {
      name: "memory.forget",
      description: "Forget one remembered key, when it is wrong or no longer true.",
      category: "memory",
      inputSchema: z.object({ key: keySchema, scope: z.enum(["project", "agent"]).default("project") }),
      permission: "WRITE",
      timeoutMs: TOOL_TIMEOUT_MS,
      availability: () => ({ available: true }),
      execute: async (input: { key: string; scope: "project" | "agent" }, toolContext) => {
        const context = await resolve(toolContext.taskId);
        const scope = input.scope === "project" && !context.projectId ? "agent" : input.scope;
        const removed = await forgetMemory(db, context.userId, target(context, scope), input.key);
        return {
          output: { removed, key: input.key, scope },
          summary: removed ? `Forgot ${input.key}` : `No ${scope} memory named ${input.key}`,
          content: removed ? `Forgot ${input.key}.` : `There was no ${scope} memory named ${input.key}.`,
        };
      },
    },
  ];
  return tools;
}

export const MEMORY_TOOL_NAMES = ["memory.remember", "memory.list", "memory.forget"] as const;

/** The memory section injected into the agent's system prompt. */
export function buildMemoryNotice(memories: { scope: string; key: string; value: string }[]): string {
  if (memories.length === 0) return "";
  const byScope = new Map<string, string[]>();
  for (const memory of memories) {
    const list = byScope.get(memory.scope) ?? [];
    list.push(`- ${memory.key}: ${memory.value}`);
    byScope.set(memory.scope, list);
  }
  return [
    "## What you remember",
    ...[...byScope.entries()].flatMap(([scope, lines]) => [`### ${scope === "project" ? "This project" : scope === "agent" ? "You" : "This conversation"}`, ...lines]),
    "",
    "These are facts you stored earlier. Use them, and correct them with memory.remember when they turn out to be wrong.",
  ].join("\n");
}

/** Where a task's files live: the project directory, or the personal workspace. */
export function projectWorkspace(root: string, userId: string, projectId: string | null): Workspace {
  const base = Workspace.forUser(root, userId);
  if (!projectId) return base;
  return new Workspace(join(base.root, "projects", projectId.replace(/[^a-zA-Z0-9_-]/g, "_")));
}
