import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, tasks } from "./agents";
import { users } from "./auth";
import { conversations, messages } from "./conversations";

/** One row per model call. Source of truth for token usage and cost reporting. */
export const usageLogs = pgTable(
  "usage_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** chat | routing | planning | step */
    purpose: text("purpose").notNull().default("chat"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    /** Null when no pricing is known for the model. */
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6, mode: "number" }),
    durationMs: integer("duration_ms").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_log_user_created_idx").on(t.userId, t.createdAt),
    index("usage_log_provider_model_idx").on(t.provider, t.model),
    index("usage_log_agent_created_idx").on(t.agentId, t.createdAt),
    index("usage_log_task_id_idx").on(t.taskId),
  ],
);

/** Append-only record of security-relevant actions. */
export const auditLogs = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_user_created_idx").on(t.userId, t.createdAt),
    index("audit_log_action_idx").on(t.action),
  ],
);
