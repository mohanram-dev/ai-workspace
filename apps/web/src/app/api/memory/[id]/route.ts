import { deleteMemoryForUser, getDatabase, getMemoryForUser, updateMemoryForUser, writeAuditLog } from "@aiw/database";
import { updateMemorySchema } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { toMemoryDto } from "@/server/project-dto";
import { requireApiSession } from "@/server/session";

type Context = RouteContext<"/api/memory/[id]">;

async function memoryId(ctx: Context): Promise<string> {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, "not_found", "Memory not found.");
  return id;
}

export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await memoryId(ctx);
    const changes = await readJson(request, updateMemorySchema);
    const updated = await updateMemoryForUser(getDatabase(), user.id, id, changes);
    if (!updated) throw new HttpError(404, "not_found", "Memory not found.");
    return Response.json(toMemoryDto(updated));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await memoryId(ctx);
    const db = getDatabase();
    const existing = await getMemoryForUser(db, user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "Memory not found.");
    await deleteMemoryForUser(db, user.id, id);
    await writeAuditLog(db, { userId: user.id, action: "memory.deleted", resourceType: "memory", resourceId: id, metadata: { key: existing.key, scope: existing.scope } });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
