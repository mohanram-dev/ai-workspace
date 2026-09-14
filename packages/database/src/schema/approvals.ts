import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents, tasks, taskSteps } from "./agents";
import { users } from "./auth";
import { toolCalls } from "./tools";

export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected", "expired", "cancelled"]);
export const approvalScope = pgEnum("approval_scope", ["once", "task"]);

/** A tool call waiting for a human decision (spec §17). The task pauses until it is decided. */
export const approvalRequests = pgTable(
  "approval_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    stepId: uuid("step_id").references(() => taskSteps.id, { onDelete: "set null" }),
    toolCallId: uuid("tool_call_id")
      .notNull()
      .references(() => toolCalls.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    permission: text("permission").notNull(),
    /** One line describing the action, shown in the approval prompt. */
    action: text("action").notNull(),
    input: jsonb("input").$type<unknown>(),
    status: approvalStatus("status").notNull().default("pending"),
    /** Set when approved: "once" or "task". */
    scope: approvalScope("scope"),
    /** Why the user rejected it, or why it expired. */
    reason: text("reason"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("approval_user_status_idx").on(t.userId, t.status), index("approval_task_idx").on(t.taskId, t.createdAt)],
);
