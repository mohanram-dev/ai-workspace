import { getAgentForUser, getConversationForUser, getDatabase, getProjectForUser, listMemoriesForUser, rememberMemory, writeAuditLog } from "@aiw/database";
import { createMemorySchema } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { toMemoryDto } from "@/server/project-dto";
import { requireApiSession } from "@/server/session";

/** GET /api/memory — everything the user and their agents remember. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const memories = await listMemoriesForUser(getDatabase(), user.id);
    return Response.json({ memories: memories.map((m) => toMemoryDto(m)) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/memory — store a fact; writing an existing key replaces its value. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const input = await readJson(request, createMemorySchema);
    const db = getDatabase();

    // The scope target must belong to the user.
    if (input.scope === "project" && !(await getProjectForUser(db, user.id, input.projectId!))) throw new HttpError(404, "not_found", "Project not found.");
    if (input.scope === "agent" && !(await getAgentForUser(db, user.id, input.agentId!))) throw new HttpError(404, "not_found", "Agent not found.");
    if (input.scope === "conversation" && !(await getConversationForUser(db, user.id, input.conversationId!))) {
      throw new HttpError(404, "not_found", "Conversation not found.");
    }

    const memory = await rememberMemory(db, {
      userId: user.id,
      scope: input.scope,
      projectId: input.projectId ?? null,
      agentId: input.agentId ?? null,
      conversationId: input.conversationId ?? null,
      key: input.key,
      value: input.value,
      source: "user",
    });
    await writeAuditLog(db, { userId: user.id, action: "memory.saved", resourceType: "memory", resourceId: memory.id, metadata: { scope: memory.scope, key: memory.key } });
    return Response.json(toMemoryDto(memory), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
