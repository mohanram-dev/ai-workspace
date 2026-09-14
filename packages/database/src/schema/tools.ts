import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents, tasks, taskSteps } from "./agents";
import { users } from "./auth";

export const toolCallStatus = pgEnum("tool_call_status", ["running", "awaiting_approval", "completed", "failed", "denied", "cancelled"]);

/** Every tool invocation by an agent, including denied and failed attempts. */
export const toolCalls = pgTable(
  "tool_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => taskSteps.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Id assigned by the model provider for this call. */
    providerCallId: text("provider_call_id"),
    toolName: text("tool_name").notNull(),
    category: text("category"),
    permission: text("permission"),
    status: toolCallStatus("status").notNull().default("running"),
    input: jsonb("input").$type<unknown>(),
    output: jsonb("output").$type<unknown>(),
    summary: text("summary"),
    error: text("error"),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("tool_call_task_created_idx").on(t.taskId, t.createdAt), index("tool_call_user_created_idx").on(t.userId, t.createdAt)],
);
