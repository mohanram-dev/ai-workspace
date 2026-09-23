import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { projects } from "./projects";

/**
 * A saved prompt the user can reuse from the composer or the Templates page.
 * `{{name}}` placeholders are filled in when it is used. The agent, project
 * and model are what the composer switches to; a deleted one is forgotten.
 */
export const promptTemplates = pgTable(
  "prompt_template",
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
    /** Most recently used first in the composer's menu. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("prompt_template_user_idx").on(t.userId)],
);
