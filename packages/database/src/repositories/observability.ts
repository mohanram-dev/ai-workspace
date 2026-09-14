import { count } from "drizzle-orm";
import type { Database } from "../client";
import { auditLogs, usageLogs, users } from "../schema";

export type NewUsageLog = typeof usageLogs.$inferInsert;
export type NewAuditLog = typeof auditLogs.$inferInsert;

export async function insertUsageLog(db: Database, values: NewUsageLog): Promise<void> {
  await db.insert(usageLogs).values(values);
}

export async function writeAuditLog(db: Database, values: NewAuditLog): Promise<void> {
  await db.insert(auditLogs).values(values);
}

export async function countUsers(db: Database): Promise<number> {
  const [row] = await db.select({ value: count() }).from(users);
  return row?.value ?? 0;
}
