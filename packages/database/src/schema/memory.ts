import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents, tasks } from "./agents";
import { users } from "./auth";
import { conversations } from "./conversations";
import { projects } from "./projects";

/** Where a memory applies (spec §25). */
export const memoryScope = pgEnum("memory_scope", ["project", "agent", "conversation"]);
/** Who wrote it: the user, or an agent through the memory tools. */
export const memorySource = pgEnum("memory_source", ["user", "agent"]);

/**
 * Structured, inspectable memory: short "key: value" facts, never whole
 * messages. Scoped to a project, an agent or one conversation.
 */
export const memories = pgTable(
  "memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: memoryScope("scope").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    source: memorySource("source").notNull().default("user"),
    /** The task that stored it, when an agent did. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("memory_user_scope_idx").on(t.userId, t.scope),
    // One value per key within a scope; writing the same key updates it.
    uniqueIndex("memory_project_key_idx").on(t.projectId, t.key).where(sqlScope("project")),
    uniqueIndex("memory_agent_key_idx").on(t.agentId, t.key).where(sqlScope("agent")),
    uniqueIndex("memory_conversation_key_idx").on(t.conversationId, t.key).where(sqlScope("conversation")),
  ],
);

/**
 * Partial-index predicate so each scope has its own unique key space. The
 * value is inlined because Postgres does not accept parameters in DDL.
 */
function sqlScope(scope: "project" | "agent" | "conversation") {
  return sql.raw(`scope = '${scope}'`);
}
