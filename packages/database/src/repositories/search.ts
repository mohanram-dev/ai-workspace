import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { Database } from "../client";
import { fileChunks } from "../schema";

export type FileChunk = typeof fileChunks.$inferSelect;
export type NewFileChunk = typeof fileChunks.$inferInsert;

export interface IndexedFile {
  path: string;
  fileMtimeMs: number;
  fileSize: number;
  model: string;
}

/** What is indexed for one workspace, one row per file. */
export async function listIndexedFiles(db: Database, userId: string, workspaceKey: string): Promise<IndexedFile[]> {
  return db
    .select({
      path: fileChunks.path,
      fileMtimeMs: max(fileChunks.fileMtimeMs).mapWith(Number),
      fileSize: max(fileChunks.fileSize).mapWith(Number),
      model: max(fileChunks.model).mapWith(String),
    })
    .from(fileChunks)
    .where(and(eq(fileChunks.userId, userId), eq(fileChunks.workspaceKey, workspaceKey)))
    .groupBy(fileChunks.path);
}

/** Replaces a file's chunks in one transaction, so a search never sees half of the old and half of the new. */
export async function replaceFileChunks(db: Database, userId: string, workspaceKey: string, path: string, rows: Omit<NewFileChunk, "userId" | "workspaceKey" | "path">[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(fileChunks).where(and(eq(fileChunks.userId, userId), eq(fileChunks.workspaceKey, workspaceKey), eq(fileChunks.path, path)));
    if (rows.length > 0) {
      await tx
        .insert(fileChunks)
        .values(rows.map((row) => ({ ...row, userId, workspaceKey, path })))
        .onConflictDoNothing();
    }
  });
}

export async function deleteFileChunks(db: Database, userId: string, workspaceKey: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await db.delete(fileChunks).where(and(eq(fileChunks.userId, userId), eq(fileChunks.workspaceKey, workspaceKey), inArray(fileChunks.path, paths)));
}

/** Every chunk of a workspace embedded with `model`, optionally under a folder. */
export async function listChunksForSearch(db: Database, userId: string, workspaceKey: string, model: string, pathPrefix?: string): Promise<FileChunk[]> {
  const filters = [eq(fileChunks.userId, userId), eq(fileChunks.workspaceKey, workspaceKey), eq(fileChunks.model, model)];
  if (pathPrefix) filters.push(sql`starts_with(${fileChunks.path}, ${pathPrefix})`);
  return db.select().from(fileChunks).where(and(...filters));
}
