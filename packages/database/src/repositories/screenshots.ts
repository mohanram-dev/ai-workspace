import { and, asc, count, desc, eq, sql, sum } from "drizzle-orm";
import type { Database } from "../client";
import { screenshots } from "../schema";

export type Screenshot = typeof screenshots.$inferSelect;
export type NewScreenshot = typeof screenshots.$inferInsert;
export type ScreenshotMeta = Omit<Screenshot, "image">;

const meta = {
  id: screenshots.id,
  taskId: screenshots.taskId,
  userId: screenshots.userId,
  toolCallId: screenshots.toolCallId,
  url: screenshots.url,
  title: screenshots.title,
  width: screenshots.width,
  height: screenshots.height,
  mimeType: screenshots.mimeType,
  bytes: screenshots.bytes,
  reason: screenshots.reason,
  source: screenshots.source,
  createdAt: screenshots.createdAt,
};

export async function insertScreenshot(db: Database, values: NewScreenshot): Promise<ScreenshotMeta> {
  const [row] = await db.insert(screenshots).values(values).returning(meta);
  if (!row) throw new Error("Failed to insert screenshot");
  return row;
}

export async function listScreenshotsForTask(db: Database, taskId: string, limit = 200): Promise<ScreenshotMeta[]> {
  return db.select(meta).from(screenshots).where(eq(screenshots.taskId, taskId)).orderBy(asc(screenshots.createdAt)).limit(limit);
}

export async function getScreenshotForUser(db: Database, userId: string, taskId: string, screenshotId: string): Promise<Screenshot | null> {
  const [row] = await db
    .select()
    .from(screenshots)
    .where(and(eq(screenshots.id, screenshotId), eq(screenshots.taskId, taskId), eq(screenshots.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Number and total size of a task's screenshots, for per-task caps. */
export async function screenshotUsageForTask(db: Database, taskId: string): Promise<{ count: number; bytes: number }> {
  const [row] = await db
    .select({ count: count(), bytes: sql<number>`coalesce(${sum(screenshots.bytes)}, 0)`.mapWith(Number) })
    .from(screenshots)
    .where(eq(screenshots.taskId, taskId));
  return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
}

/** Removes the oldest screenshots of a task beyond `keep`. */
export async function pruneScreenshotsForTask(db: Database, taskId: string, keep: number): Promise<number> {
  const stale = await db.select({ id: screenshots.id }).from(screenshots).where(eq(screenshots.taskId, taskId)).orderBy(desc(screenshots.createdAt)).offset(keep);
  if (stale.length === 0) return 0;
  for (const row of stale) await db.delete(screenshots).where(eq(screenshots.id, row.id));
  return stale.length;
}
