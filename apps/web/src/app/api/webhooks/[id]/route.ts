import { deleteWebhookForUser, getDatabase, getWebhookForUser, updateWebhookForUser, writeAuditLog } from "@aiw/database";
import { updateWebhookSchema } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { toWebhookDto } from "@/server/webhooks";
import { assertOwnAgentAndProject } from "@/server/ownership";
import { requireApiSession } from "@/server/session";

type Context = RouteContext<"/api/webhooks/[id]">;

async function webhookId(ctx: Context): Promise<string> {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, "not_found", "Webhook not found.");
  return id;
}

/** PATCH /api/webhooks/:id — edit, or switch on and off. */
export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await webhookId(ctx);
    const changes = await readJson(request, updateWebhookSchema);
    const db = getDatabase();
    await assertOwnAgentAndProject(db, user.id, changes);
    const updated = await updateWebhookForUser(db, user.id, id, {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.prompt !== undefined ? { prompt: changes.prompt } : {}),
      ...(changes.agentId !== undefined ? { agentId: changes.agentId ?? null } : {}),
      ...(changes.projectId !== undefined ? { projectId: changes.projectId ?? null } : {}),
      ...(changes.model !== undefined ? { model: changes.model ?? null } : {}),
      ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
    });
    if (!updated) throw new HttpError(404, "not_found", "Webhook not found.");
    await writeAuditLog(db, { userId: user.id, action: "webhook.updated", resourceType: "webhook", resourceId: id, metadata: { fields: Object.keys(changes) } });
    return Response.json(toWebhookDto((await getWebhookForUser(db, user.id, id))!));
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/webhooks/:id — the URL stops working immediately. */
export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await webhookId(ctx);
    const db = getDatabase();
    if (!(await deleteWebhookForUser(db, user.id, id))) throw new HttpError(404, "not_found", "Webhook not found.");
    await writeAuditLog(db, { userId: user.id, action: "webhook.deleted", resourceType: "webhook", resourceId: id });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
