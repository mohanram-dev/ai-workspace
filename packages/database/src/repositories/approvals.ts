import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "../client";
import { agents, approvalRequests, tasks } from "../schema";

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type NewApprovalRequest = typeof approvalRequests.$inferInsert;
export interface ApprovalWithContext extends ApprovalRequest {
  agentName: string | null;
  taskPrompt: string;
}

export async function insertApprovalRequest(db: Database, values: NewApprovalRequest): Promise<ApprovalRequest> {
  const [row] = await db.insert(approvalRequests).values(values).returning();
  if (!row) throw new Error("Failed to create approval request");
  return row;
}

export async function getApprovalRequest(db: Database, id: string): Promise<ApprovalRequest | null> {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
  return row ?? null;
}

export async function getApprovalForUser(db: Database, userId: string, id: string): Promise<ApprovalWithContext | null> {
  const [row] = await db
    .select({ approval: approvalRequests, agentName: agents.name, taskPrompt: tasks.prompt })
    .from(approvalRequests)
    .innerJoin(tasks, eq(approvalRequests.taskId, tasks.id))
    .leftJoin(agents, eq(approvalRequests.agentId, agents.id))
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)))
    .limit(1);
  return row ? { ...row.approval, agentName: row.agentName, taskPrompt: row.taskPrompt } : null;
}

export async function listApprovalsForTask(db: Database, taskId: string): Promise<ApprovalRequest[]> {
  return db.select().from(approvalRequests).where(eq(approvalRequests.taskId, taskId)).orderBy(asc(approvalRequests.createdAt));
}

export async function listPendingApprovalsForUser(db: Database, userId: string, limit = 50): Promise<ApprovalWithContext[]> {
  const rows = await db
    .select({ approval: approvalRequests, agentName: agents.name, taskPrompt: tasks.prompt })
    .from(approvalRequests)
    .innerJoin(tasks, eq(approvalRequests.taskId, tasks.id))
    .leftJoin(agents, eq(approvalRequests.agentId, agents.id))
    .where(and(eq(approvalRequests.userId, userId), eq(approvalRequests.status, "pending")))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.approval, agentName: r.agentName, taskPrompt: r.taskPrompt }));
}

/** Tool names the user approved for the whole task, so later calls skip the prompt. */
export async function listTaskApprovedTools(db: Database, taskId: string): Promise<string[]> {
  const rows = await db
    .select({ toolName: approvalRequests.toolName })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.taskId, taskId), eq(approvalRequests.status, "approved"), eq(approvalRequests.scope, "task")));
  return [...new Set(rows.map((r) => r.toolName))];
}

/**
 * Records a decision, but only while the request is still pending, so a
 * decision cannot overwrite another one (or a timeout).
 */
export async function decideApproval(
  db: Database,
  id: string,
  decision: { status: "approved" | "rejected" | "expired" | "cancelled"; scope?: "once" | "task"; reason?: string | null; decidedBy?: string | null },
): Promise<ApprovalRequest | null> {
  const [row] = await db
    .update(approvalRequests)
    .set({
      status: decision.status,
      ...(decision.scope ? { scope: decision.scope } : {}),
      reason: decision.reason ?? null,
      decidedBy: decision.decidedBy ?? null,
      decidedAt: new Date(),
    })
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, "pending")))
    .returning();
  return row ?? null;
}

/** Marks pending requests of finished tasks (or past their deadline) as expired/cancelled. */
export async function expireStaleApprovals(db: Database, now = new Date()): Promise<number> {
  const rows = await db
    .update(approvalRequests)
    .set({ status: "expired", reason: "The approval request expired.", decidedAt: now })
    .where(and(eq(approvalRequests.status, "pending"), lt(approvalRequests.expiresAt, now)))
    .returning({ id: approvalRequests.id });
  return rows.length;
}

export async function cancelPendingApprovalsForTasks(db: Database, taskIds: string[], reason: string): Promise<number> {
  if (taskIds.length === 0) return 0;
  const rows = await db
    .update(approvalRequests)
    .set({ status: "cancelled", reason, decidedAt: new Date() })
    .where(and(eq(approvalRequests.status, "pending"), inArray(approvalRequests.taskId, taskIds)))
    .returning({ id: approvalRequests.id });
  return rows.length;
}
