import { getApprovalForUser, getDatabase, writeAuditLog } from "@aiw/database";
import { rejectRequestSchema } from "@aiw/shared";
import { toApprovalDto } from "@/server/agent-dto";
import { getAgentServices } from "@/server/agents";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** POST /api/approvals/:id/reject — the agent is told and continues without the action. */
export async function POST(request: Request, ctx: RouteContext<"/api/approvals/[id]/reject">): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Approval request not found.");
    const { reason } = await readJson(request, rejectRequestSchema);

    const db = getDatabase();
    const existing = await getApprovalForUser(db, user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "Approval request not found.");
    if (existing.status !== "pending") throw new HttpError(409, "conflict", `This request was already ${existing.status}.`);

    const decided = await getAgentServices().approvals.decide(id, { status: "rejected", reason: reason ?? null, decidedBy: user.id });
    if (!decided) throw new HttpError(409, "conflict", "This request was just decided by someone else.");
    await writeAuditLog(db, {
      userId: user.id,
      action: "approval.rejected",
      resourceType: "approval_request",
      resourceId: id,
      metadata: { tool: decided.toolName, taskId: decided.taskId, action: decided.action, reason: reason ?? null },
    });
    return Response.json(toApprovalDto(decided, { agentName: existing.agentName, taskPrompt: existing.taskPrompt }));
  } catch (error) {
    return errorResponse(error);
  }
}
