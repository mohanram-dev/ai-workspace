import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents, tasks, taskSteps } from "./agents";
import { users } from "./auth";

/**
 * Append-only execution timeline. The bigserial id orders events globally and
 * doubles as the SSE event id for resuming streams.
 */
export const taskEvents = pgTable(
  "task_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Denormalised so the timeline survives agent renames and deletions. */
    agentName: text("agent_name"),
    stepId: uuid("step_id").references(() => taskSteps.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    status: text("status").notNull().default("info"),
    toolName: text("tool_name"),
    durationMs: integer("duration_ms"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("task_event_task_id_idx").on(t.taskId, t.id), index("task_event_user_created_idx").on(t.userId, t.createdAt)],
);
