import { customType, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * A piece of a workspace file with its embedding, for searching by meaning
 * (files.semantic_search). Vectors are float32 bytes compared in the server:
 * no pgvector extension, so the stock Postgres image keeps working. A file is
 * re-embedded when its mtime, size or the embedding model changes.
 */
export const fileChunks = pgTable(
  "file_chunk",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "personal" or a project id: which of the user's workspaces the file is in. */
    workspaceKey: text("workspace_key").notNull(),
    path: text("path").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    content: text("content").notNull(),
    fileMtimeMs: doublePrecision("file_mtime_ms").notNull(),
    fileSize: integer("file_size").notNull(),
    model: text("model").notNull(),
    embedding: bytea("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("file_chunk_workspace_idx").on(t.userId, t.workspaceKey),
    // Two tasks indexing the same file at once cannot duplicate it.
    uniqueIndex("file_chunk_unique_idx").on(t.userId, t.workspaceKey, t.path, t.chunkIndex),
  ],
);
