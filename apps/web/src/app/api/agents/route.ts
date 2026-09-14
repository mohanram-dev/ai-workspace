import { ensureBuiltinAgents } from "@aiw/agents";
import { countActiveTasksByAgent, createAgent, getDatabase, listAgentsForUser, writeAuditLog } from "@aiw/database";
import { createAgentSchema } from "@aiw/shared";
import { toAgentDto } from "@/server/agent-dto";
import { customAgentSlug, validateAgentModel, validateAgentTools } from "@/server/agent-validation";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/agents — the user's agents (built-ins are created on first access). */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const db = getDatabase();
    await ensureBuiltinAgents(db, user.id);
    const [agents, activity] = await Promise.all([listAgentsForUser(db, user.id), countActiveTasksByAgent(db, user.id)]);
    return Response.json({ agents: agents.map((a) => toAgentDto(a, activity.get(a.id))) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/agents — create a custom agent. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const input = await readJson(request, createAgentSchema);
    await validateAgentModel(input.provider, input.model);
    await validateAgentTools(user.id, input.tools);

    const db = getDatabase();
    const agent = await createAgent(db, { ...input, tools: [...new Set(input.tools)], permissions: [...new Set(input.permissions)], ownerId: user.id, slug: customAgentSlug(input.name), builtin: false });
    await writeAuditLog(db, { userId: user.id, action: "agent.created", resourceType: "agent", resourceId: agent.id });
    return Response.json(toAgentDto(agent), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
