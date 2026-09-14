import { customType, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tasks } from "./agents";
import { users } from "./auth";
import { toolCalls } from "./tools";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** Screenshots captured by the browser tools (JPEG), shown in the task's Browser tab. */
export const screenshots = pgTable(
  "screenshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    title: text("title"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    mimeType: text("mime_type").notNull().default("image/jpeg"),
    bytes: integer("bytes").notNull(),
    /** Why it was taken: open, click, type, …, or "requested". */
    reason: text("reason").notNull(),
    /** "browser" or "computer". */
    source: text("source").notNull().default("browser"),
    image: bytea("image").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("screenshot_task_created_idx").on(t.taskId, t.createdAt)],
);
