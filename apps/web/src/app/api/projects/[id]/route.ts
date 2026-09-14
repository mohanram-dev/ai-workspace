import { deleteProjectForUser, getDatabase, getProjectForUser, updateProjectForUser, writeAuditLog } from "@aiw/database";
import { updateProjectSchema } from "@aiw/shared";
import { toProjectDto } from "@/server/project-dto";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";

type Context = RouteContext<"/api/projects/[id]">;

async function projectId(ctx: Context): Promise<string> {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, "not_found", "Project not found.");
  return id;
}

export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const project = await getProjectForUser(getDatabase(), user.id, await projectId(ctx));
    if (!project) throw new HttpError(404, "not_found", "Project not found.");
    return Response.json(toProjectDto(project));
  } catch (error) {
    return errorResponse(error);
  }
}

/** PATCH /api/projects/:id — rename, describe or archive. */
export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await projectId(ctx);
    const changes = await readJson(request, updateProjectSchema);
    const db = getDatabase();
    const updated = await updateProjectForUser(db, user.id, id, {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.archived !== undefined ? { archivedAt: changes.archived ? new Date() : null } : {}),
    });
    if (!updated) throw new HttpError(404, "not_found", "Project not found.");
    await writeAuditLog(db, { userId: user.id, action: "project.updated", resourceType: "project", resourceId: id, metadata: { fields: Object.keys(changes) } });
    const withCounts = await getProjectForUser(db, user.id, id);
    return Response.json(toProjectDto(withCounts!));
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/projects/:id — its conversations and tasks survive without a project; its memory is removed. */
export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await projectId(ctx);
    const db = getDatabase();
    if (!(await deleteProjectForUser(db, user.id, id))) throw new HttpError(404, "not_found", "Project not found.");
    await writeAuditLog(db, { userId: user.id, action: "project.deleted", resourceType: "project", resourceId: id });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
