import { deleteTemplateForUser, getDatabase, getTemplateForUser, updateTemplateForUser } from "@aiw/database";
import { updateTemplateSchema } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";
import { assertOwnAgentAndProject } from "@/server/ownership";
import { toTemplateDto } from "@/server/templates";

type Context = RouteContext<"/api/templates/[id]">;

async function templateId(ctx: Context): Promise<string> {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, "not_found", "Template not found.");
  return id;
}

/** PATCH /api/templates/:id */
export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await templateId(ctx);
    const changes = await readJson(request, updateTemplateSchema);
    const db = getDatabase();
    await assertOwnAgentAndProject(db, user.id, changes);

    const updated = await updateTemplateForUser(db, user.id, id, {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.prompt !== undefined ? { prompt: changes.prompt } : {}),
      ...(changes.agentId !== undefined ? { agentId: changes.agentId ?? null } : {}),
      ...(changes.projectId !== undefined ? { projectId: changes.projectId ?? null } : {}),
      ...(changes.model !== undefined ? { model: changes.model ?? null } : {}),
    });
    if (!updated) throw new HttpError(404, "not_found", "Template not found.");
    return Response.json(toTemplateDto((await getTemplateForUser(db, user.id, id))!));
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/templates/:id */
export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await templateId(ctx);
    if (!(await deleteTemplateForUser(getDatabase(), user.id, id))) throw new HttpError(404, "not_found", "Template not found.");
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
