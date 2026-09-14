import {
  deleteAgentForUser,
  getAgentForUser,
  getDatabase,
  updateAgentForUser,
  writeAuditLog,
} from "@aiw/database";
import { updateAgentSchema } from "@aiw/shared";
import { toAgentDto } from "@/server/agent-dto";
import { validateAgentModel, validateAgentTools } from "@/server/agent-validation";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";

type Context = RouteContext<"/api/agents/[id]">;

async function agentId(ctx: Context): Promise<string> {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, "not_found", "Agent not found.");
  return id;
}

export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const agent = await getAgentForUser(getDatabase(), user.id, await agentId(ctx));
    if (!agent) throw new HttpError(404, "not_found", "Agent not found.");
    return Response.json(toAgentDto(agent));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await agentId(ctx);
    const changes = await readJson(request, updateAgentSchema);
    const db = getDatabase();

    const existing = await getAgentForUser(db, user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "Agent not found.");
    if (changes.provider !== undefined || changes.model !== undefined) {
      await validateAgentModel(changes.provider ?? existing.provider, changes.model !== undefined ? changes.model : existing.model);
    }

    if (changes.tools) await validateAgentTools(user.id, changes.tools);
    const updated = await updateAgentForUser(db, user.id, id, {
      ...changes,
      ...(changes.tools ? { tools: [...new Set(changes.tools)] } : {}),
      ...(changes.permissions ? { permissions: [...new Set(changes.permissions)] } : {}),
    });
    if (!updated) throw new HttpError(404, "not_found", "Agent not found.");
    await writeAuditLog(db, {
      userId: user.id,
      action: "agent.updated",
      resourceType: "agent",
      resourceId: id,
      metadata: { fields: Object.keys(changes) },
    });
    return Response.json(toAgentDto(updated));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await agentId(ctx);
    const db = getDatabase();

    const existing = await getAgentForUser(db, user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "Agent not found.");
    if (existing.builtin) {
      throw new HttpError(400, "bad_request", "Built-in agents cannot be deleted. Disable the agent instead.");
    }
    await deleteAgentForUser(db, user.id, id);
    await writeAuditLog(db, { userId: user.id, action: "agent.deleted", resourceType: "agent", resourceId: id });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
