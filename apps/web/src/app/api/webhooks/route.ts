import { countWebhooksForUser, createWebhook, getDatabase, getWebhookForUser, listWebhooksForUser, writeAuditLog } from "@aiw/database";
import { createWebhookSchema, MAX_WEBHOOKS_PER_USER, type WebhookWithSecretDto } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { generateWebhookSecret, toWebhookDto, webhookSecretBox } from "@/server/webhooks";
import { assertOwnAgentAndProject } from "@/server/ownership";
import { requireApiSession } from "@/server/session";

/** GET /api/webhooks — the user's inbound webhooks (without their secrets). */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const webhooks = await listWebhooksForUser(getDatabase(), user.id);
    return Response.json({ webhooks: webhooks.map(toWebhookDto) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/webhooks — create a webhook. The response is the only time its secret is shown. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const input = await readJson(request, createWebhookSchema);
    const db = getDatabase();
    await assertOwnAgentAndProject(db, user.id, input);
    if ((await countWebhooksForUser(db, user.id)) >= MAX_WEBHOOKS_PER_USER) {
      throw new HttpError(409, "conflict", `You already have ${MAX_WEBHOOKS_PER_USER} webhooks. Delete one to add another.`);
    }

    const secret = generateWebhookSecret();
    const webhook = await createWebhook(db, {
      userId: user.id,
      name: input.name,
      prompt: input.prompt,
      agentId: input.agentId ?? null,
      projectId: input.projectId ?? null,
      model: input.model ?? null,
      enabled: input.enabled ?? true,
      secretEncrypted: webhookSecretBox().encrypt(secret),
    });
    await writeAuditLog(db, { userId: user.id, action: "webhook.created", resourceType: "webhook", resourceId: webhook.id, metadata: { name: webhook.name } });
    const body: WebhookWithSecretDto = { ...toWebhookDto((await getWebhookForUser(db, user.id, webhook.id))!), secret };
    return Response.json(body, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
