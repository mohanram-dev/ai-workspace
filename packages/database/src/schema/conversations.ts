import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { MessageAttachment } from "@aiw/shared";
import { tasks } from "./agents";
import { users } from "./auth";
import { projects } from "./projects";

export const messageRole = pgEnum("message_role", ["user", "assistant", "system"]);
export const messageStatus = pgEnum("message_status", [
  "streaming",
  "completed",
  "failed",
  "cancelled",
]);

export const conversations = pgTable(
  "conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("conversation_user_last_message_idx").on(t.userId, t.lastMessageAt.desc()),
    index("conversation_project_id_idx").on(t.projectId),
  ],
);

export const messages = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Agent task that produces this assistant message. */
    taskId: uuid("task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull().default(""),
    status: messageStatus("status").notNull().default("completed"),
    provider: text("provider"),
    model: text("model"),
    /** Human-readable failure reason for failed assistant messages. */
    error: text("error"),
    finishReason: text("finish_reason"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Files the user attached to this message; the bytes live in the workspace (spec §3, §24). */
    attachments: jsonb("attachments").$type<MessageAttachment[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("message_conversation_created_idx").on(t.conversationId, t.createdAt),
    index("message_task_id_idx").on(t.taskId),
  ],
);
