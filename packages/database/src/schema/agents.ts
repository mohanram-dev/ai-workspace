import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { TaskError, TaskRouting } from "@aiw/shared";
import { users } from "./auth";
import { conversations } from "./conversations";
import { projects } from "./projects";

export const agentPlanningMode = pgEnum("agent_planning_mode", ["auto", "always", "never"]);

/** Per-user agent configuration. Built-in agents are seeded per user and can be edited or disabled. */
export const agents = pgTable(
  "agent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    builtin: boolean("builtin").notNull().default(false),
    name: text("name").notNull(),
    description: text("description").notNull(),
    instructions: text("instructions").notNull().default(""),
    provider: text("provider").notNull().default("gemini"),
    /** null = provider default model. */
    model: text("model"),
    temperature: real("temperature").notNull().default(0.7),
    maxOutputTokens: integer("max_output_tokens").notNull().default(8192),
    planningMode: agentPlanningMode("planning_mode").notNull().default("auto"),
    maxSteps: integer("max_steps").notNull().default(5),
    maxExecutionSeconds: integer("max_execution_seconds").notNull().default(300),
    dailyBudgetUsd: numeric("daily_budget_usd", { precision: 10, scale: 4, mode: "number" }),
    useConversationHistory: boolean("use_conversation_history").notNull().default(true),
    maxHistoryMessages: integer("max_history_messages").notNull().default(20),
    enabled: boolean("enabled").notNull().default(true),
    routable: boolean("routable").notNull().default(true),
    /** Tool names the agent may call (built-in and, later, MCP tools). */
    tools: text("tools").array().notNull().default(sql`'{}'::text[]`),
    /** Granted permission levels beyond READ (WRITE, EXECUTE, NETWORK). DESTRUCTIVE always needs approval. */
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    maxToolCalls: integer("max_tool_calls").notNull().default(20),
    /**
     * Autonomous mode (spec §27): the agent runs trusted destructive tools
     * without stopping for approval. The floor in NEVER_AUTONOMOUS still applies.
     */
    autonomousMode: boolean("autonomous_mode").notNull().default(false),
    /** Tool names pre-approved while autonomous mode is on. */
    trustedTools: text("trusted_tools").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("agent_owner_slug_idx").on(t.ownerId, t.slug)],
);

export const taskStatus = pgEnum("task_status", [
  "queued",
  "planning",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const taskStepStatus = pgEnum("task_step_status", ["pending", "running", "completed", "failed", "cancelled"]);

/** One agent execution. Retries create a new row linked through `retryOfTaskId`. */
export const tasks = pgTable(
  "task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    retryOfTaskId: uuid("retry_of_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    attempt: integer("attempt").notNull().default(1),
    /** Set when an agent delegated this task to another agent (spec §28). */
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    /** 0 for a task you started; each delegation adds one. */
    depth: integer("depth").notNull().default(0),
    prompt: text("prompt").notNull(),
    status: taskStatus("status").notNull().default("queued"),
    /** Set when the user asks to pause; the runtime pauses at the next step boundary. */
    pauseRequestedAt: timestamp("pause_requested_at", { withTimezone: true }),
    routing: jsonb("routing").$type<TaskRouting>(),
    /** Model requested for this task, overriding the agent's model. */
    modelOverride: text("model_override"),
    provider: text("provider"),
    model: text("model"),
    result: text("result"),
    error: jsonb("error").$type<TaskError>(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6, mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("task_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("task_user_status_idx").on(t.userId, t.status),
    index("task_agent_id_idx").on(t.agentId),
    index("task_conversation_id_idx").on(t.conversationId),
    index("task_status_idx").on(t.status),
  ],
);

export const taskSteps = pgTable(
  "task_step",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    title: text("title").notNull(),
    instruction: text("instruction").notNull(),
    status: taskStepStatus("status").notNull().default("pending"),
    output: text("output"),
    error: text("error"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [uniqueIndex("task_step_task_index_idx").on(t.taskId, t.index)],
);
