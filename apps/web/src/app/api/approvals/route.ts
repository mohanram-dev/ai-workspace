import { getDatabase, listPendingApprovalsForUser } from "@aiw/database";
import { toApprovalDto } from "@/server/agent-dto";
import { errorResponse } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/approvals — the user's pending approval requests. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const approvals = await listPendingApprovalsForUser(getDatabase(), user.id);
    return Response.json({ approvals: approvals.map((a) => toApprovalDto(a, { agentName: a.agentName, taskPrompt: a.taskPrompt })) });
  } catch (error) {
    return errorResponse(error);
  }
}
