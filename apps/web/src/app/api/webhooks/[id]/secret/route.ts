import { getDatabase, getWebhookForUser, updateWebhookForUser, writeAuditLog } from "@aiw/database";
import type { WebhookWithSecretDto } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid } from "@/server/http";
import { generateWebhookSecret, toWebhookDto, webhookSecretBox } from "@/server/webhooks";
import { requireApiSession } from "@/server/session";

/** POST /api/webhooks/:id/secret — replace the secret; the old one stops working at once. */
export async function POST(request: Request, ctx: RouteContext<"/api/webhooks/[id]/secret">): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Webhook not found.");
    const db = getDatabase();
    const secret = generateWebhookSecret();
    if (!(await updateWebhookForUser(db, user.id, id, { secretEncrypted: webhookSecretBox().encrypt(secret) }))) {
      throw new HttpError(404, "not_found", "Webhook not found.");
    }
    await writeAuditLog(db, { userId: user.id, action: "webhook.secret_rotated", resourceType: "webhook", resourceId: id });
    const body: WebhookWithSecretDto = { ...toWebhookDto((await getWebhookForUser(db, user.id, id))!), secret };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
