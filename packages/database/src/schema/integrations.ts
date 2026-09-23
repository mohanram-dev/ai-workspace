import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents, tasks } from "./agents";
import { users } from "./auth";
import { conversations } from "./conversations";
import { projects } from "./projects";

/**
 * A personal API token for starting and reading tasks from outside the app.
 * Only its SHA-256 is stored: the token is shown once, when it is created.
 */
export const apiTokens = pgTable(
  "api_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** The first characters, so a token can be recognised in the list without being stored. */
    prefix: text("prefix").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_token_user_idx").on(t.userId)],
);

/**
 * An inbound webhook: a URL that starts a task from a saved prompt when a
 * service (n8n, GitHub, a cron job elsewhere) posts to it with the secret.
 */
export const webhooks = pgTable(
  "webhook",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    model: text("model"),
    /** Encrypted (SecretBox), not hashed: verifying a GitHub signature needs the secret itself. */
    secretEncrypted: text("secret_encrypted").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** One conversation per webhook, like a schedule's. */
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    lastTaskId: uuid("last_task_id").references(() => tasks.id, { onDelete: "set null" }),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    triggerCount: integer("trigger_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("webhook_user_idx").on(t.userId)],
);
